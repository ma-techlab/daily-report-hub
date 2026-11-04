// Apps Script は src/*.js を1つのグローバルに読み込む。同じ名前の関数が2つあると後勝ちで黙って上書きされるため、
// すべてのファイルをつなげて構文と名前の重複を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

test('全ファイルをつなげても構文エラーにならない', () => {
  const code = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx);
  for (const name of ['handleFormSubmit', 'remindMissing', 'sendWeeklySummary', 'setup', 'onOpen', 'seedDemoData', 'refreshStoreChoices']) {
    assert.equal(typeof ctx[name], 'function', name);
  }
});

test('トップレベルの関数・変数の名前がファイル間で重複しない', () => {
  const seen = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^(?:function\s+([\w$]+)|var\s+([\w$]+))/gm)) {
      const name = m[1] || m[2];
      assert.ok(!seen.has(name), `${name} が ${seen.get(name)} と ${f} の両方にあります`);
      seen.set(name, f);
    }
  }
});

test('トリガーとメニューから呼ぶ関数は、末尾が _ の非公開関数ではない', () => {
  const setup = fs.readFileSync(path.join(dir, 'Setup.js'), 'utf8');
  const called = [...setup.matchAll(/(?:addItem\([^,]+,\s*|newTrigger\()'([\w$]+)'/g)].map((m) => m[1]);
  assert.ok(called.length >= 7);
  for (const name of called) assert.ok(!name.endsWith('_'), name);
});
