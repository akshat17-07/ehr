import { Encrypter } from 'age-encryption';

// Backup files are encrypted by us with `age` before they leave the API (docs/india/aws-hosting-plan.md "Backups").
// Only the public recipient key is configured here; the secret identity is kept offline and used to restore.

export const AGE_RECIPIENT = /^age1[0-9a-z]{58}$/;

/** Encrypts to one age X25519 recipient ("age1..."). Throws before doing anything if the recipient is malformed. */
export async function encryptForBackup(data: Uint8Array, recipient: string): Promise<Uint8Array> {
  if (!AGE_RECIPIENT.test(recipient)) throw new Error('BACKUP_AGE_RECIPIENT is not a valid age recipient');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(data);
}
