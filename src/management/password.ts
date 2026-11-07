import { hash } from 'bcryptjs';

// Provision locally via stdin; never put a plaintext password in process arguments.
let password = '';
for await (const chunk of process.stdin) {
  password += String(chunk);
  if (Buffer.byteLength(password) > 1024) throw new Error('Password input too long');
}
password = password.replace(/\r?\n$/, '');
if (password.length < 12 || Buffer.byteLength(password) > 72 || /[\r\n]/.test(password))
  throw new Error(
    'Use a single-line password of at least 12 characters and at most 72 UTF-8 bytes',
  );
console.log(`MANAGEMENT_PASSWORD_HASH='${await hash(password, 12)}'`);
