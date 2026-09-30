#!/usr/bin/env node
/**
 * bcrypt 哈希生成工具。
 *
 * 用途：seed 迁移里需要写死的口令哈希，用本脚本生成后粘贴进 SQL。
 * 这样迁移文件是纯 SQL、不含 Node 依赖，且 seed 本身保持幂等。
 *
 *   npm run seed:hash -- mySecretPassword
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (password === undefined || password === '') {
  console.error('用法：npm run seed:hash -- <password>');
  process.exit(2);
}

const hash = bcrypt.hashSync(password, 10);
console.log(hash);
