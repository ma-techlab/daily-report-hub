const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setupContext() {
  const alerts = [];
  const context = vm.createContext({
    SpreadsheetApp: {
      getUi: () => ({ alert: (message) => alerts.push(message) }),
    },
    FormApp: { ItemType: { LIST: 'LIST' } },
  });
  for (const file of ['Logic.js', 'Store.js', 'Setup.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    vm.runInContext(src, context);
  }
  return { context, alerts };
}

test('店舗マスタ：IDが空で店舗名のある行も読み取り、設定エラーにする', () => {
  const { context } = setupContext();
  context.rows_ = () => [
    ['', 'IDなし店', 'a@example.com', '日', true],
    ['S01', '', 'b@example.com', '', true],
    ['', '', '', '', false],
  ];
  const stores = context.loadStores_();
  assert.equal(stores.length, 2);
  const errors = context.storeMasterErrors(stores).join('\n');
  assert.match(errors, /店舗IDが空/);
  assert.match(errors, /店舗名が空/);
});

test('初期設定：店舗ID・店舗名の問題があるとフォームを作らず停止する', () => {
  const { context, alerts } = setupContext();
  context.sheet_ = () => {};
  context.loadStores_ = () => [
    { id: 'S01', name: '同名店', active: true },
    { id: 'S02', name: '同名店', active: true },
  ];
  let formCreated = false;
  context.getOrCreateForm_ = () => { formCreated = true; return {}; };

  context.setup();

  assert.equal(formCreated, false);
  assert.match(alerts[0], /店舗名が重複/);
});

test('フォーム更新：有効店舗が0件なら既存フォームを変更せず停止する', () => {
  const { context, alerts } = setupContext();
  context.loadStores_ = () => [{ id: 'S09', name: '閉店', active: false }];
  let formOpened = false;
  context.getOrCreateForm_ = () => { formOpened = true; return {}; };

  assert.equal(context.refreshStoreChoices(), false);
  assert.equal(formOpened, false);
  assert.match(alerts[0], /有効な店舗がない/);
});

test('フォーム更新：有効店舗だけを選択肢に反映する', () => {
  const { context } = setupContext();
  context.loadStores_ = () => [
    { id: 'S01', name: '本町店', active: true },
    { id: 'S02', name: '港店', active: true },
    { id: 'S09', name: '閉店', active: false },
  ];
  let choices;
  const listItem = {
    getTitle: () => context.FORM_FIELDS.store,
    asListItem: () => ({ setChoiceValues: (values) => { choices = values; } }),
  };
  context.getOrCreateForm_ = () => ({ getItems: () => [listItem] });

  assert.equal(context.refreshStoreChoices(), true);
  assert.deepEqual(Array.from(choices), ['本町店', '港店']);
});
