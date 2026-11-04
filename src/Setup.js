/**
 * 日報ハブ — 初期設定とメニュー。
 *
 * スプレッドシートの「日報ハブ」メニューから実行する。
 * 1. 初期設定（シート・フォーム・トリガーを作成）
 * 2. 店舗マスタを変えたら「フォームの店舗を更新」
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('日報ハブ')
    .addItem('初期設定（シート・フォーム・トリガー）', 'setup')
    .addItem('フォームの店舗を更新', 'refreshStoreChoices')
    .addSeparator()
    .addItem('いま未提出の店舗を確認（リマインド）', 'remindMissing')
    .addItem('前週のまとめを作成', 'sendWeeklySummary')
    .addSeparator()
    .addItem('デモ用の架空データを入れる', 'seedDemoData')
    .addToUi();
}

function setup() {
  Object.keys(SHEETS).forEach(sheet_);
  if (!loadStores_().length) {
    SpreadsheetApp.getUi().alert('先に「店舗マスタ」に店舗を1つ以上登録してください（デモなら「デモ用の架空データを入れる」）。');
    return;
  }
  var form = getOrCreateForm_();
  refreshStoreChoices();
  installTriggers_();
  SpreadsheetApp.getUi().alert(
    '初期設定が終わりました。\n\nフォームの回答用URL：\n' + form.getPublishedUrl() +
    '\n\nメールは、スクリプト プロパティで DRY_RUN=false にするまで送信されず、「送信ログ」に記録だけされます。');
}

/** フォームを作る。作成済みなら、そのフォームを返す。 */
function getOrCreateForm_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FORM_ID');
  if (id) {
    try { return FormApp.openById(id); } catch (err) { /* 削除されていたら作り直す */ }
  }

  var form = FormApp.create('店舗日報')
    .setDescription('営業日の終わりに、各店舗の責任者が1日1回送信してください。同じ日を送り直すと、内容が上書きされます。')
    .setCollectEmail(false);

  form.addListItem().setTitle(FORM_FIELDS.store).setRequired(true);
  form.addDateItem().setTitle(FORM_FIELDS.date).setRequired(true);

  var count = FormApp.createTextValidation().requireWholeNumber().setHelpText('0以上の整数で入力してください').build();
  ['planned', 'served', 'leftover', 'staff'].forEach(function (key) {
    form.addTextItem().setTitle(FORM_FIELDS[key]).setRequired(true).setValidation(count);
  });

  form.addMultipleChoiceItem().setTitle(FORM_FIELDS.hygiene).setChoiceValues([HYGIENE_OK, HYGIENE_NG]).setRequired(true);
  form.addMultipleChoiceItem().setTitle(FORM_FIELDS.consult).setChoiceValues([CONSULT_NO, CONSULT_YES]).setRequired(true);
  form.addParagraphTextItem().setTitle(FORM_FIELDS.note).setHelpText('相談の内容や、明日への引き継ぎがあれば');

  form.setDestination(FormApp.DestinationType.SPREADSHEET, SpreadsheetApp.getActiveSpreadsheet().getId());
  props.setProperty('FORM_ID', form.getId());
  return form;
}

/** 店舗マスタの有効な店舗を、フォームの選択肢に反映する。 */
function refreshStoreChoices() {
  var form = getOrCreateForm_();
  var names = loadStores_().filter(function (s) { return s.active; }).map(function (s) { return s.name; });
  var item = form.getItems(FormApp.ItemType.LIST).filter(function (i) { return i.getTitle() === FORM_FIELDS.store; })[0];
  item.asListItem().setChoiceValues(names);
}

/** このプロジェクトのトリガーを作り直す。何度実行しても重複しない。 */
function installTriggers_() {
  var handlers = ['handleFormSubmit', 'remindMissing', 'sendWeeklySummary'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  var config = getConfig_();
  ScriptApp.newTrigger('handleFormSubmit').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onFormSubmit().create();
  ScriptApp.newTrigger('remindMissing').timeBased().everyDays(1).atHour(config.remindHour).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendWeeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(config.weeklyHour).inTimezone(TZ).create();
}

/**
 * デモ用の架空データ。店舗マスタと、直近4週間の日報を入れる。
 * 本番のデータと混ざらないよう、日報シートが空のときだけ実行する。
 */
function seedDemoData() {
  if (rows_('reports').length) {
    SpreadsheetApp.getUi().alert('日報シートにデータがあるため、デモデータは入れませんでした。');
    return;
  }
  if (!rows_('stores').length) {
    var stores = [
      ['S01', 'みどり食堂 本町店', 'store-s01@example.com', '日', true],
      ['S02', 'みどり食堂 港店', 'store-s02@example.com', '日', true],
      ['S03', '社員食堂 北工場', 'store-s03@example.com', '土,日', true],
      ['S04', '社員食堂 南工場', 'store-s04@example.com', '土,日', true],
      ['S05', '病院給食 中央', 'store-s05@example.com', '', true],
    ];
    sheet_('stores').getRange(2, 1, stores.length, stores[0].length).setValues(stores);
  }

  var storeList = loadStores_();
  var config = getConfig_();
  var today = today_();
  var rows = [];
  var seed = 7;
  function rand() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

  for (var back = 28; back >= 1; back--) {
    var date = addDays(today, -back);
    storeList.forEach(function (store) {
      if (!isOpenOn(store, date)) return;
      if (rand() < 0.06) return; // ときどき未提出
      var planned = 120 + Math.floor(rand() * 180);
      var served = planned - Math.floor(rand() * planned * 0.12);
      var leftover = Math.floor(served * (rand() < 0.1 ? 0.18 + rand() * 0.05 : 0.03 + rand() * 0.07));
      var report = {
        storeId: store.id, storeName: store.name, date: date,
        planned: planned, served: served, leftover: leftover,
        staff: 4 + Math.floor(rand() * 5),
        hygieneOk: rand() > 0.04,
        consult: rand() < 0.05,
        note: '',
      };
      if (report.consult) report.note = '冷蔵庫の温度表示が不安定。点検の手配を相談したい';
      var reasons = attentionReasons(report, config.thresholds);
      rows.push([reportKey(store.id, date), date, store.id, store.name, planned, served, leftover,
        Math.round(leftoverRate(report) * 1000) / 1000, report.staff,
        report.hygieneOk ? HYGIENE_OK : HYGIENE_NG, report.consult ? CONSULT_YES : CONSULT_NO,
        report.note, reasons.join(' / '), date + ' 18:30:00', 0]);
    });
  }
  sheet_('reports').getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  SpreadsheetApp.getUi().alert('架空の店舗5件と、日報' + rows.length + '件を入れました。');
}
