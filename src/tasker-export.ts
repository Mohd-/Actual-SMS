import { readFile } from 'node:fs/promises';
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export async function taskerProject(origin: string, key: string) {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Use an HTTPS origin without credentials, path, query or fragment');
  const template = await readFile('tasker/Actual_SMS_Inbox.prj.xml', 'utf8');
  if ((template.match(/<exportval><\/exportval>/g) ?? []).length !== 2)
    throw new Error('Unexpected Tasker template variables');
  let index = 0;
  return template.replace(
    /<exportval><\/exportval>/g,
    () => `<exportval>${xml(index++ === 0 ? key : url.origin)}</exportval>`,
  );
}
