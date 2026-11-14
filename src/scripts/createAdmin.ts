import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { db } from '../config/db';
import { container } from '../container';
import { PASSWORD_MIN_LENGTH } from '../modules/auth/auth.schema';

/**
 * Creates the administrator, or resets the password of an existing one.
 * Usage: npm run create-admin -- <username>
 * The password is read from ADMIN_PASSWORD or prompted for, never taken from argv,
 * so it does not end up in shell history or the process list.
 */
async function main() {
  const username = process.argv[2]?.trim();
  if (!username || !/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Usage: create-admin <username> (3-64 chars: letters, digits, . _ -)');
  }

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const prompt = createInterface({ input: stdin, output: stdout });
    password = await prompt.question('Password: ');
    prompt.close();
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  await container.authService.createOrResetAdmin(username, password);
  console.log(`Administrator "${username}" is ready.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
