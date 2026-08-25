#!/usr/bin/env node
/* Mutation runner — proves the test suite would notice if the code broke.
 *
 *   1. copy the app somewhere isolated (a real server boot rewrites data/):
 *        rm -rf /tmp/mf && mkdir -p /tmp/mf
 *        tar cf - --exclude=./data --exclude=./node_modules . | (cd /tmp/mf && tar xf -)
 *        ln -sfn "$PWD/node_modules" /tmp/mf/node_modules
 *   2. run it:
 *        node test/mutate.js test/mutations.json
 *
 *   MUT_ROOT   where the isolated copy lives          (default /tmp/mf)
 *   MUT_SUITE  which suite to run for each mutation   (default test/voice.test.js)
 *
 * Each entry in the JSON list is {label, file, find, replace}. `find` is an exact
 * substring and must appear exactly once, otherwise the mutation is reported as
 * NOT APPLIED — that is a broken mutation, not a passing test.
 *
 * Three outcomes:
 *   caught (n)   the suite failed n checks. Good: the code is load-bearing.
 *   NOT CAUGHT   the suite passed with the code broken. Either the assertion is
 *                vacuous, or a second guard is covering for the mutated one.
 *   CRASH        the suite errored instead of failing a check, so everything
 *                after it went unmeasured. Make the harness tolerate the fault
 *                (null-object stubs, try/catch around the call) and re-run.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.env.MUT_ROOT || '/tmp/mf';
const SUITE = process.env.MUT_SUITE || 'test/voice.test.js';
const listPath = process.argv[2] || path.join(__dirname, 'mutations.json');

if (!fs.existsSync(path.join(ROOT, SUITE))) {
  console.error(`No ${SUITE} under ${ROOT} — copy the app there first (see the header of this file).`);
  process.exit(2);
}

const muts = JSON.parse(fs.readFileSync(listPath, 'utf8'));
let bad = 0;

for (const m of muts) {
  const file = path.join(ROOT, m.file);
  const orig = fs.readFileSync(file, 'utf8');
  const n = orig.split(m.find).length - 1;
  if (n !== 1) {
    console.log(`NOT APPLIED  ${m.label}  (${n} matches)`);
    bad++;
    continue;
  }
  fs.writeFileSync(file, orig.replace(m.find, m.replace));
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', [SUITE], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    failed = true;
    out = (err.stdout || '') + (err.stderr || '');
  }
  fs.writeFileSync(file, orig);   // always restore, even if the suite blew up
  const fails = out.split('\n').filter(l => /^ {2}FAIL/.test(l))
    .map(l => l.replace(/^ {2}FAIL {2}/, '').slice(0, 78));
  const crashed = /harness error|SyntaxError/.test(out);
  if (!failed) {
    console.log(`NOT CAUGHT   ${m.label}`);
    bad++;
  } else if (crashed && !fails.length) {
    console.log(`CRASH        ${m.label}  (suite errored rather than failing a check)`);
    bad++;
  } else {
    console.log(`caught (${String(fails.length).padStart(2)})  ${m.label}`);
    fails.slice(0, 3).forEach(f => console.log(`             > ${f}`));
  }
}
console.log(bad === 0 ? '\nALL MUTATIONS CAUGHT' : `\n${bad} MUTATION(S) NOT CAUGHT`);
process.exit(bad ? 1 : 0);
