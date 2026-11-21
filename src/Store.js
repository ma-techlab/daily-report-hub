/**
 * 日報ハブ — 設定・シート・メールの読み書き。
 *
 * 秘密の値や宛先はコードに書かず、スクリプト プロパティで管理する。
 * DRY_RUN が 'false' 以外のあいだは、メールを送らず「送信ログ」に記録だけする。
 */

var TZ = 'Asia/Tokyo';

var SHEETS = {
  stores: '店舗マスタ',
  reports: '日報',
  weekly: '週次集計',
  log: '送信ログ',
  errors: '受付エラー',
};

var HEADERS = {
  stores: ['店舗ID', '店舗名', '責任者メール', '定休曜日', '有効'],
  reports: ['キー', '営業日', '店舗ID', '店舗名', '予定食数', '提供食数', '残食数', '残食率', '出勤人数',
    '衛生点検', '本部への相談', '連絡事項', '要対応の理由', '受信日時', '修正回数'],
  weekly: ['週', '店舗ID', '店舗名', '営業日数', '提出数', '提出率', '提供食数', '残食率', '要対応件数', '作成日時'],
  log: ['日時', '種類', '宛先', '件名', '状態'],
  errors: ['受信日時', '店舗', '営業日', '理由'],
};

/** スクリプト プロパティから設定を読む。未設定の値は安全側の既定値にする。 */
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  function num(key, fallback, min, max, integerOnly) {
    var raw = props.getProperty(key);
    var v = Number(raw);
    return raw !== null && String(raw).trim() !== '' && isFinite(v) &&
      v >= min && v <= max && (!integerOnly || Math.floor(v) === v) ? v : fallback;
  }
  return {
    hqEmail: props.getProperty('HQ_EMAIL') || '',
    dryRun: props.getProperty('DRY_RUN') !== 'false',
    remindHour: num('REMIND_HOUR', 15, 0, 23, true),
    weeklyHour: num('WEEKLY_HOUR', 8, 0, 23, true),
    thresholds: {
      leftoverRate: num('LEFTOVER_ALERT_RATE', 0.15, 0, 1, false),
      shortageRate: num('SHORTAGE_ALERT_RATE', 0.1, 0, 1, false),
    },
  };
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function now_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

/** シートを取得する。なければ見出しつきで作る。 */
function sheet_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS[key]);
  if (!sh) {
    sh = ss.insertSheet(SHEETS[key]);
    sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 見出しを除いた全行。 */
function rows_(key) {
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS[key].length).getValues();
}

/** 店舗マスタ。 */
function loadStores_() {
  return rows_('stores')
    .filter(function (r) {
      return String(r[0]).trim() !== '' || String(r[1]).trim() !== '' || String(r[2]).trim() !== '' ||
        String(r[3]).trim() !== '' || r[4] === true;
    })
    .map(function (r) {
      return {
        id: String(r[0]).trim(),
        name: String(r[1]).trim(),
        email: String(r[2]).trim(),
        closedWeekdays: parseClosedWeekdays(r[3]),
        active: r[4] === true || String(r[4]).toUpperCase() === 'TRUE',
      };
    });
}

/** 日報の全件。集計に必要な列だけを返す。 */
function loadReports_() {
  return rows_('reports').map(function (r) {
    return {
      key: String(r[0]),
      date: cellDate_(r[1]),
      storeId: String(r[2]),
      served: Number(r[5]) || 0,
      leftover: Number(r[6]) || 0,
      attention: String(r[12]) !== '',
    };
  });
}

/** 日付のセルは Date で返ることがあるので、'yyyy-MM-dd' にそろえる。 */
function cellDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  return String(value);
}

/**
 * 日報を1行書く。同じ店舗・営業日の行があれば上書きし、修正回数を1増やす。
 * 戻り値は { updated: 上書きしたか }。
 */
function upsertReport_(report, reasons) {
  var sh = sheet_('reports');
  var key = reportKey(report.storeId, report.date);
  var keys = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
  var index = keys.indexOf(key);
  var revisions = index === -1 ? 0 : Number(sh.getRange(index + 2, 15).getValue()) + 1;

  var row = [
    key,
    report.date,
    report.storeId,
    sanitizeCell(report.storeName),
    report.planned,
    report.served,
    report.leftover,
    Math.round(leftoverRate(report) * 1000) / 1000,
    report.staff,
    report.hygieneOk ? HYGIENE_OK : HYGIENE_NG,
    report.consult ? CONSULT_YES : CONSULT_NO,
    sanitizeCell(report.note),
    sanitizeCell(reasons.join(' / ')),
    now_(),
    revisions,
  ];

  if (index === -1) {
    sh.appendRow(row);
  } else {
    sh.getRange(index + 2, 1, 1, row.length).setValues([row]);
  }
  return { updated: index !== -1 };
}

function logError_(storeName, date, errors) {
  sheet_('errors').appendRow([now_(), sanitizeCell(storeName), sanitizeCell(date), sanitizeCell(errors.join(' / '))]);
}

/**
 * メールを送る。DRY_RUN のあいだは送らずにログだけ残す。
 * 宛先が空、または1日の送信上限に近いときも送らない。
 */
function sendMail_(kind, to, subject, htmlBody) {
  var config = getConfig_();
  var status;
  if (!to) {
    status = '宛先なしのため未送信';
  } else if (config.dryRun) {
    status = 'DRY_RUN（未送信）';
  } else if (MailApp.getRemainingDailyQuota() < 5) {
    status = '送信上限に近いため未送信';
  } else {
    try {
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: htmlBody, name: '日報ハブ' });
      status = '送信';
    } catch (err) {
      status = '失敗：' + (err && err.message ? err.message : err);
    }
  }
  sheet_('log').appendRow([now_(), kind, sanitizeCell(to), sanitizeCell(subject), status]);
  return status;
}
