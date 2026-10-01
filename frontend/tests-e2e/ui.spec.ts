/**
 * 控制台 UI 端到端测试（C3 选做，5.26）。
 *
 * 覆盖 bash 脚本无法验证的"界面层"行为：
 *  - 未登录一律重定向登录页；错误口令有明确错误提示
 *  - admin 登录：4 个预置账号、操作列与侧边栏身份
 *  - viewer 登录：界面无任何写操作入口；直接调后端写接口同样 403（双保险）
 *  - 账号状态按钮按 FSM 显隐（有 online 账号时验证 标记离线→重连）
 *  - 退出登录后回登录页，后退也看不到内容
 *  - 群列表导航可渲染
 *
 * 前置：docker compose 服务已启动（前端 5173 / 后端 3000）。
 */
import { expect, test, type Page } from '@playwright/test';

/** 经登录表单登录，成功后落在账号页。 */
async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  // 成功标志：侧边栏出现
  await expect(page.locator('.brand')).toHaveText('消息平台控制台');
}

test.describe('登录与权限', () => {
  test('未登录访问任意路径 → 重定向到登录页', async ({ page }) => {
    await page.goto('/accounts');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: '多账号群组消息平台' })).toBeVisible();
  });

  test('错误口令 → 提示"用户名或密码错误"，停留在登录页', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page.locator('.error-text')).toHaveText('用户名或密码错误');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('admin 登录成功：4 个预置账号 + 操作列 + 管理员身份', async ({ page }) => {
    await login(page, 'admin', 'admin');
    await expect(page).toHaveURL(/\/accounts$/);

    // 4 个预置账号全部渲染
    for (const id of ['acct-1', 'acct-2', 'acct-3', 'acct-4']) {
      await expect(page.getByText(id, { exact: true })).toBeVisible();
    }
    // 管理员可见操作列
    await expect(page.getByRole('columnheader', { name: '操作' })).toBeVisible();
    // 侧边栏显示身份
    await expect(page.locator('.user')).toContainText('管理员');
  });

  test('viewer 登录：界面无写按钮；直接调写接口得到 403', async ({ page, request }) => {
    await login(page, 'viewer', 'viewer');
    await expect(page.locator('.user')).toContainText('只读');

    // 表格无操作列
    await expect(page.getByRole('columnheader', { name: '操作' })).toHaveCount(0);
    // 页面上不存在任何状态写操作按钮
    for (const name of ['标记离线', '重连', '释放账号']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }

    // 接口层双保险：用 viewer 身份直接 POST 写接口 → 403
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'viewer', password: 'viewer' },
    });
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    // 先取一个账号 id
    const accountsRes = await request.get('/api/accounts', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const accounts = (await accountsRes.json()) as { id: string }[];
    const blocked = await request.post(`/api/accounts/${accounts[0]!.id}/connect`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(blocked.status()).toBe(403);
  });
});

test.describe('账号状态操作（admin）', () => {
  test('online 账号：标记离线 → 出现重连 → 重连恢复在线', async ({ page }) => {
    await login(page, 'admin', 'admin');

    // 等账号表加载完成（登录成功仅代表壳渲染，表格数据是异步拉取）
    await expect(page.getByText('acct-1', { exact: true })).toBeVisible();
    const row = page.locator('tr', { hasText: 'acct-1' });
    const markOffline = row.getByRole('button', { name: '标记离线' });

    // 没有 online 账号（此前测试把账号置为其它状态）时跳过，避免依赖外部状态
    if ((await markOffline.count()) === 0) {
      test.skip(true, 'acct-1 当前不是 online，跳过状态切换用例');
    }

    await markOffline.click();
    // 状态变为已离线，同行动态出现"重连"按钮
    await expect(row.getByRole('button', { name: '重连' })).toBeVisible();
    await expect(row.locator('.badge')).toHaveText('已离线');

    await row.getByRole('button', { name: '重连' }).click();
    await expect(row.locator('.badge')).toHaveText('在线');
  });
});

test.describe('导航与退出', () => {
  test('群导航可渲染；退出后回登录页，后退看不到内容', async ({ page }) => {
    await login(page, 'admin', 'admin');

    // 页脚也有同名链接，显式限定侧栏，避免严格模式多元素冲突
    await page.locator('.sidebar').getByRole('link', { name: '群' }).click();
    await expect(page).toHaveURL(/\/groups$/);
    await expect(page.getByRole('heading', { name: '群列表' })).toBeVisible();
    // 有群则显示行，无群则显示空态——二者之一，不应报错
    const hasRows = await page.locator('tbody tr').count();
    if (hasRows > 0) {
      await expect(page.getByRole('columnheader', { name: '群 ID' })).toBeVisible();
    } else {
      await expect(page.getByText('暂无群')).toBeVisible();
    }

    // 退出登录
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 后退：路由守卫再次重定向回登录页，看不到控制台内容
    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('.brand')).toHaveCount(0);
  });
});
