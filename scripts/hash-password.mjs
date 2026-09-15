#!/usr/bin/env node
/**
 * Generates a scrypt hash for a viewer password.
 *
 *   node scripts/hash-password.mjs 'correct horse battery staple'
 *   node scripts/hash-password.mjs            # prompts, nothing lands in shell history
 *
 * Paste the result into the `passwordHash` field of the USERS_JSON secret.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { hashPassword } from '../backend/src/crypto-utils.mjs';

const fromArgs = argv.slice(2).join(' ');

const password = fromArgs || (await promptForPassword());
if (!password) {
  console.error('No password supplied.');
  exit(1);
}

console.log(hashPassword(password));

async function promptForPassword() {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return (await rl.question('Password: ')).trim();
  } finally {
    rl.close();
  }
}
