/* Authoring command line: describe forms of a sandbox application. Credentials come from the environment. */
import {appServer, AppConnection} from './index';

async function main(argv: string[]) {
  const [command, app, ...forms] = argv;
  if (command !== 'discover' || !app || !forms.length) {
    console.error('Usage: APP_URL=… APP_USER=… APP_PASSWORD=… [APP_DB=…] node out/src/apps/cli.js discover <frappe|odoo> <form>…');
    process.exit(2);
  }
  const connection = {app, url: process.env.APP_URL ?? '', user: process.env.APP_USER ?? '', password: process.env.APP_PASSWORD ?? '',
    db: process.env.APP_DB} as AppConnection;
  const server = appServer(connection);
  const described = [];
  for (const form of forms) described.push(await server.describe(form));
  process.stdout.write(JSON.stringify(described, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
