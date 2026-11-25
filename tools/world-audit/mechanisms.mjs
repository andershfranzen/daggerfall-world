// Installed-data reconciliation of every authored RDB action record against the production executor
// (server/rpg/interiors/actions.js, rules in client/world/interiors/dungeonActions.js).
// Prints counts and record identifiers only. Never exports game text or assets.
//
//   node tools/world-audit/mechanisms.mjs            summary JSON
//   node tools/world-audit/mechanisms.mjs --records  also every record that needs evidence beyond its family
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { arena2Dir, openSources } from './sources.mjs';
import { parseRdb, RDB_TYPE } from '../../client/world/interiors/blocks.js';
import {
  OP, TRIGGER, actionRecord, opcodeFamily, triggerFlag, doorTextRecord, textInputRecord, TEXT_BASE, TEXT_INPUT_ANSWERS,
  hazardAmount, collisionTrigger,
} from '../../client/world/interiors/dungeonActions.js';
import { parseTextRsc } from '../../client/gameplay/character/classic.js';
import { loadCatalogue } from '../../server/rpg/magic/catalogue.js';

const dir = arena2Dir();
if (!dir) throw new Error('Set ARENA2_DIR to the installed classic data.');
const { data } = await openSources({ arena2: dir });
const rscPath = ['TEXT.RSC', 'text.rsc'].map((n) => join(dir, n)).find(existsSync);
const rsc = rscPath ? parseTextRsc(new Uint8Array(readFileSync(rscPath))) : null;
const spells = loadCatalogue({ arena2Dir: dir }).spells;

const families = {};
const opcodes = {};
const triggers = {};
const evidence = { unexplained: [], missingText: [], missingAnswers: [], spells: { resolved: 0, unsupported: [], missing: [] }, zeroDamage: [], brokenLinks: [], globals: [], dialogueArchives: {} };
let records = 0;
let blocks = 0;
for (const entry of data.blocks.entries) {
  if (!/\.RDB$/i.test(entry.name)) continue;
  const rdb = parseRdb(await data.blocks.read(data.blocks.indexOfName(entry.name)), entry.name);
  blocks++;
  const byOffset = new Map(rdb.objects.map((o) => [o.position, o]));
  for (const obj of rdb.objects) {
    const a = actionRecord(obj);
    if (!a) continue;
    records++;
    const family = opcodeFamily(a.opcode);
    families[family] = (families[family] ?? 0) + 1;
    opcodes[a.opcode] = (opcodes[a.opcode] ?? 0) + 1;
    const t = triggerFlag(a.trigger);
    triggers[t] = (triggers[t] ?? 0) + 1;
    const ref = obj.type === RDB_TYPE.Model ? rdb.modelReferences[obj.model.modelIndex] : null;
    const id = { block: entry.name, offset: obj.position, opcode: a.opcode, trigger: a.trigger, index: a.index, axis: a.axis,
      object: ref ? `model ${ref.modelId} ${ref.description}` : `flat ${obj.flat.archive}.${obj.flat.record}` };
    const next = a.nextOffset > 0 ? byOffset.get(a.nextOffset) : null;
    if (a.nextOffset > 0 && !next) evidence.brokenLinks.push(id);
    const nextOp = next ? actionRecord(next)?.opcode ?? null : null;
    switch (family) {
      case 'text':
        if (!rsc?.has(TEXT_BASE[OP.TEXT] + a.index)) evidence.missingText.push({ ...id, record: TEXT_BASE[OP.TEXT] + a.index });
        break;
      case 'textInput':
        if (!rsc?.has(textInputRecord(a))) evidence.missingText.push({ ...id, record: textInputRecord(a) });
        if (!TEXT_INPUT_ANSWERS[textInputRecord(a)]) evidence.missingAnswers.push({ ...id, record: textInputRecord(a) });
        break;
      case 'doorText': {
        const r = doorTextRecord(a);
        if (r != null && !rsc?.has(r)) evidence.missingText.push({ ...id, record: r });
        break;
      }
      case 'spell': {
        const sp = spells.get(`std:${a.index}`);
        if (!sp) evidence.spells.missing.push(id);
        else if (sp.support === 'unsupported') evidence.spells.unsupported.push({ ...id, spell: sp.name });
        else evidence.spells.resolved++;
        break;
      }
      case 'damage':
        if (a.opcode !== OP.HURT_RANDOM && !hazardAmount(a, { level: 1 })?.amount) evidence.zeroDamage.push(id);
        break;
      case 'global':
        evidence.globals.push({ ...id, global: a.axis });
        break;
      case 'dialogue':
        evidence.dialogueArchives[id.object.split(' ')[0] === 'flat' ? obj.flat.archive : 'model'] =
          (evidence.dialogueArchives[obj.flat?.archive ?? 'model'] ?? 0) + 1;
        break;
      case 'chain':
        if (![OP.ACTIVATE].includes(a.opcode)) {
          evidence.unexplained.push({ ...id, nextOpcode: nextOp, collision: collisionTrigger(a.trigger), direct: [TRIGGER.DIRECT, TRIGGER.DIRECT6].includes(t) });
        }
        break;
    }
  }
}

const summary = {
  blocks, records, families, opcodes, triggers,
  unresolvedFamilies: Object.keys(opcodes).filter((op) => !opcodeFamily(Number(op))).length,
  textFile: !!rsc,
  missingText: evidence.missingText.length,
  missingAnswers: evidence.missingAnswers.length,
  spells: { resolved: evidence.spells.resolved, unsupported: evidence.spells.unsupported.length, missing: evidence.spells.missing.length },
  zeroDamage: evidence.zeroDamage.length,
  brokenLinks: evidence.brokenLinks.length,
  globals: evidence.globals.map((g) => `${g.block}@${g.offset}=${g.global}`),
  dialogueArchives: evidence.dialogueArchives,
  unexplained: evidence.unexplained.length,
};
console.log(JSON.stringify(process.argv.includes('--records') ? { ...summary, evidence } : summary, null, 2));
