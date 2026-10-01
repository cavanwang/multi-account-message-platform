/**
 * C1 媒体下载器（规划 05 任务 5.25）。
 *
 * 把 message 事件 mediaUrl 指向的文件下载到本地 MEDIA_DIR：
 *   - 严格超时（5s，AbortController），防止慢连接拖垮事件处理；
 *   - 限大小（10MB），超限放弃（可由重复事件重试）；
 *   - 文件名一律后端生成（UUID + 安全扩展名），杜绝用 URL 拼路径造成的穿越；
 *   - 原子落盘：先写 `.<name>.tmp` 再 rename，清理 worker 不会读到半截文件。
 *
 * 结果三分类，调用方据此决定是否重试：
 *   downloaded 成功；not_found 404（过期/未注册，重试无意义）；
 *   failed 网络/超时/超限/5xx（重复事件或后续补救可重试）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 单个媒体大小上限 10MB（题面未规定，取保守值）。 */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** 下载超时 5 秒。 */
export const DOWNLOAD_TIMEOUT_MS = 5_000;

export type DownloadOutcome =
  | { kind: 'downloaded'; filePath: string }
  | { kind: 'not_found' }
  | { kind: 'failed' };

/**
 * @param mediaUrl 事件里的地址，相对路径（`/media/x`）按 gatewayBaseUrl 补全
 * @param mediaDir 本地下载目录
 * @param gatewayBaseUrl 网关根地址（如 http://gateway-mock:3100）
 */
export async function downloadMedia(
  mediaUrl: string,
  mediaDir: string,
  gatewayBaseUrl: string,
): Promise<DownloadOutcome> {
  // 相对/绝对 URL 统一解析
  let url: URL;
  try {
    url = new URL(mediaUrl, gatewayBaseUrl);
  } catch {
    return { kind: 'failed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      // 网络错误 / abort（超时）→ 可重试
      return { kind: 'failed' };
    }

    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok || res.body === null) return { kind: 'failed' };

    // 边读边累计，超过上限立即停止（不信任 Content-Length）
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MEDIA_BYTES) {
          // 超限：取消读取，放弃本次（不写任何文件）
          await reader.cancel().catch(() => {});
          return { kind: 'failed' };
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return { kind: 'failed' };
    }

    // 文件名后端生成；扩展名只接受路径末段上的简短安全后缀，其余一律 .bin
    const ext = safeExtension(url.pathname);
    const finalName = `${randomUUID()}${ext}`;
    const finalPath = join(mediaDir, finalName);
    const tmpPath = join(mediaDir, `.${finalName}.tmp`);

    await mkdir(mediaDir, { recursive: true });
    // 原子写：临时文件 → rename，同目录 rename 在同一文件系统上是原子的
    await writeFile(tmpPath, Buffer.concat(chunks), { signal: controller.signal });
    await rename(tmpPath, finalPath);
    return { kind: 'downloaded', filePath: finalPath };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 URL 路径末段提取安全扩展名（`.jpg` 等），限制 1–8 位字母数字；
 * 不合法或没有时返回 `.bin`。绝不使用调用方给的文件名（防穿越）。
 */
function safeExtension(pathname: string): string {
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? '';
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(lastSegment);
  return m !== null ? `.${m[1]!.toLowerCase()}` : '.bin';
}
