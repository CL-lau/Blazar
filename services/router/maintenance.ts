import { copyRouterDatabase } from './backup.ts';

const [command, archive, ...extra] = process.argv.slice(2);
if ((command !== 'backup' && command !== 'restore') || !archive || extra.length) {
  console.error('Usage: npm run router:db -- <backup|restore> <archive.sqlite>');
  process.exitCode = 2;
} else {
  try {
    const path = await copyRouterDatabase(command, process.env.BLAZAR_DB ?? 'blazar.sqlite', archive);
    console.log(path);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Database operation failed');
    process.exitCode = 1;
  }
}
