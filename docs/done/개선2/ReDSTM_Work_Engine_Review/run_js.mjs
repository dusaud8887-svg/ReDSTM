import { parseTitle, serialWorks, migrateNovelState } from './baseline/text-work.mjs';
let input = '';
for await (const part of process.stdin) input += part;
const payload = JSON.parse(input);
console.log(JSON.stringify({
  parsed: (payload.titles ?? []).map((title) => ({title, ...parseTitle(title)})),
  groups: (payload.groups ?? []).map((posts) => serialWorks(posts)),
  migration: payload.migration ? (() => {
    const state = payload.migration.state;
    const changed = migrateNovelState(state, payload.migration.items);
    return {changed, state};
  })() : null,
}));
