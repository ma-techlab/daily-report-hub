/**
 * 日報ハブ — 判定・集計の純粋関数。
 *
 * スプレッドシートやメールに触れない処理だけをここに置き、Node のテストで検証する。
 * 日付はすべて 'yyyy-MM-dd' の文字列で扱い、実行環境のタイムゾーンに左右されないようにする。
 * Apps Script では全ファイルが同じグローバルに読み込まれるため、末尾の module.exports は
 * Node で読み込んだときだけ働く。
 */

var WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** フォームの質問文。フォームの作成と回答の読み取りの両方で使う。 */
var FORM_FIELDS = {
  store: '店舗',
  date: '営業日',
  planned: '予定食数',
  served: '提供食数',
  leftover: '残食数',
  staff: '出勤人数',
  hygiene: '衛生点検',
  consult: '本部への相談',
  note: '連絡事項',
};

var HYGIENE_OK = 'すべて実施';
var HYGIENE_NG = '未実施の項目あり';
var CONSULT_YES = 'あり';
var CONSULT_NO = 'なし';

/** 'yyyy-MM-dd' として正しい日付かどうか。 */
function isDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  var d = toUtcDate_(value);
  return formatUtcDate_(d) === value;
}

/** '2026/10/5' や '2026-10-05' を 'yyyy-MM-dd' にそろえる。読めない値はそのまま返す。 */
function normalizeDate(value) {
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return s;
  function pad(n) { return (n.length < 2 ? '0' : '') + n; }
  return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
}

/** 曜日（0=日〜6=土）。 */
function weekdayOf(dateStr) {
  return toUtcDate_(dateStr).getUTCDay();
}

/** 日付に日数を足す。 */
function addDays(dateStr, days) {
  var d = toUtcDate_(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcDate_(d);
}

/** 基準日の前週（月曜〜日曜）。週次の集計は、締まった1週間だけを対象にする。 */
function previousWeek(todayStr) {
  var weekday = weekdayOf(todayStr); // 0=日
  var daysSinceMonday = (weekday + 6) % 7;
  var thisMonday = addDays(todayStr, -daysSinceMonday);
  var start = addDays(thisMonday, -7);
  return { start: start, end: addDays(start, 6) };
}

/** 店舗がその日に営業するか。定休曜日と有効フラグを見る。 */
function isOpenOn(store, dateStr) {
  if (!store.active) return false;
  var closed = store.closedWeekdays || [];
  return closed.indexOf(WEEKDAYS_JA[weekdayOf(dateStr)]) === -1;
}

/** 「日,土」のような定休曜日の文字列を配列にする。曜日以外の文字は無視する。 */
function parseClosedWeekdays(text) {
  return String(text || '')
    .split(/[,、\s・]+/)
    .map(function (s) { return s.replace(/曜日?$/, ''); })
    .filter(function (s) { return WEEKDAYS_JA.indexOf(s) !== -1; });
}

/** 同じ店舗・同じ営業日の日報を1行にまとめるためのキー。 */
function reportKey(storeId, dateStr) {
  return storeId + '|' + dateStr;
}

/**
 * フォームの回答を日報の形に整える。
 * 数値は0以上の整数だけを受け付け、問題があれば errors に理由を入れて返す。
 * 店舗名は店舗マスタで店舗IDに置き換える（マスタにない店舗は受け付けない）。
 */
function normalizeReport(answers, stores) {
  var errors = [];
  var storeName = String(answers[FORM_FIELDS.store] || '').trim();
  var store = null;
  for (var i = 0; i < stores.length; i++) {
    if (stores[i].name === storeName) { store = stores[i]; break; }
  }
  if (!store) errors.push('店舗マスタにない店舗です：' + storeName);

  var date = normalizeDate(answers[FORM_FIELDS.date]);
  if (!isDateString(date)) errors.push('営業日の形式が正しくありません：' + date);

  function count(field) {
    var raw = String(answers[FORM_FIELDS[field]] == null ? '' : answers[FORM_FIELDS[field]]).trim();
    if (!/^\d+$/.test(raw)) {
      errors.push(FORM_FIELDS[field] + 'は0以上の整数で入力してください：' + raw);
      return null;
    }
    return Number(raw);
  }

  var planned = count('planned');
  var served = count('served');
  var leftover = count('leftover');
  var staff = count('staff');
  if (served !== null && leftover !== null && leftover > served) {
    errors.push('残食数が提供食数を上回っています');
  }

  return {
    errors: errors,
    report: {
      storeId: store ? store.id : '',
      storeName: storeName,
      date: date,
      planned: planned,
      served: served,
      leftover: leftover,
      staff: staff,
      hygieneOk: String(answers[FORM_FIELDS.hygiene] || '') === HYGIENE_OK,
      consult: String(answers[FORM_FIELDS.consult] || '') === CONSULT_YES,
      note: String(answers[FORM_FIELDS.note] || '').trim(),
    },
  };
}

/** 残食率。提供食数が0なら0とする。 */
function leftoverRate(report) {
  if (!report.served) return 0;
  return report.leftover / report.served;
}

/**
 * 本部がすぐ見るべき理由を返す。空配列なら通知しない。
 * thresholds.leftoverRate：残食率の上限（例 0.15）
 * thresholds.shortageRate：予定に対する提供不足の上限（例 0.1）
 */
function attentionReasons(report, thresholds) {
  var reasons = [];
  if (!report.hygieneOk) reasons.push('衛生点検に未実施の項目があります');
  if (report.consult) reasons.push('本部への相談があります');
  var rate = leftoverRate(report);
  if (rate > thresholds.leftoverRate) {
    reasons.push('残食率が' + formatPercent(rate) + 'です（基準 ' + formatPercent(thresholds.leftoverRate) + '）');
  }
  if (report.planned > 0) {
    var shortage = (report.planned - report.served) / report.planned;
    if (shortage > thresholds.shortageRate) {
      reasons.push('提供食数が予定より' + (report.planned - report.served) + '食少ない');
    }
  }
  return reasons;
}

/** その日に営業しているのに、日報が届いていない店舗。 */
function findMissingStores(stores, reportKeys, dateStr) {
  return stores.filter(function (store) {
    return isOpenOn(store, dateStr) && reportKeys.indexOf(reportKey(store.id, dateStr)) === -1;
  });
}

/**
 * 1週間分の店舗別の集計。
 * 提出率は「営業日のうち日報が届いた日」の割合。定休日は分母に入れない。
 */
function summarizeWeek(stores, reports, week) {
  var rows = stores.filter(function (s) { return s.active; }).map(function (store) {
    var openDays = 0;
    for (var i = 0; i < 7; i++) {
      if (isOpenOn(store, addDays(week.start, i))) openDays++;
    }
    var mine = reports.filter(function (r) {
      return r.storeId === store.id && r.date >= week.start && r.date <= week.end;
    });
    var served = 0;
    var leftover = 0;
    var attention = 0;
    mine.forEach(function (r) {
      served += r.served;
      leftover += r.leftover;
      if (r.attention) attention++;
    });
    return {
      storeId: store.id,
      storeName: store.name,
      openDays: openDays,
      submitted: mine.length,
      submitRate: openDays ? mine.length / openDays : 1,
      served: served,
      leftover: leftover,
      leftoverRate: served ? leftover / served : 0,
      attention: attention,
    };
  });

  var total = rows.reduce(function (acc, r) {
    acc.openDays += r.openDays;
    acc.submitted += r.submitted;
    acc.served += r.served;
    acc.leftover += r.leftover;
    acc.attention += r.attention;
    return acc;
  }, { openDays: 0, submitted: 0, served: 0, leftover: 0, attention: 0 });

  return {
    week: week,
    rows: rows,
    total: {
      openDays: total.openDays,
      submitted: total.submitted,
      submitRate: total.openDays ? total.submitted / total.openDays : 1,
      served: total.served,
      leftoverRate: total.served ? total.leftover / total.served : 0,
      attention: total.attention,
    },
  };
}

/** 週次まとめのメール本文（HTML）。値はすべてエスケープする。 */
function renderWeeklyHtml(summary) {
  var head = ['店舗', '提出', '提出率', '提供食数', '残食率', '要対応'];
  function row(cells, strong) {
    var tag = strong ? 'th' : 'td';
    return '<tr>' + cells.map(function (c) {
      return '<' + tag + ' style="border:1px solid #d9e2f1;padding:6px 10px;text-align:right">' + escapeHtml(c) + '</' + tag + '>';
    }).join('') + '</tr>';
  }
  var body = summary.rows.map(function (r) {
    return row([r.storeName, r.submitted + '/' + r.openDays, formatPercent(r.submitRate),
      r.served.toLocaleString('ja-JP'), formatPercent(r.leftoverRate), String(r.attention)]);
  });
  var t = summary.total;
  body.push(row(['全店', t.submitted + '/' + t.openDays, formatPercent(t.submitRate),
    t.served.toLocaleString('ja-JP'), formatPercent(t.leftoverRate), String(t.attention)], true));

  return '<p>' + escapeHtml(summary.week.start + '〜' + summary.week.end) + ' の日報のまとめです。</p>' +
    '<table style="border-collapse:collapse;font-size:14px">' + row(head, true) + body.join('') + '</table>' +
    '<p style="color:#56688a;font-size:12px">提出率は、定休日を除いた営業日のうち日報が届いた日の割合です。</p>';
}

function formatPercent(rate) {
  return (Math.round(rate * 1000) / 10).toFixed(1) + '%';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** スプレッドシートに書く文字列の先頭が数式とみなされる記号なら、無害化する。 */
function sanitizeCell(value) {
  var s = String(value == null ? '' : value);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function toUtcDate_(dateStr) {
  var p = String(dateStr).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
}

function formatUtcDate_(d) {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

if (typeof module !== 'undefined') {
  module.exports = {
    FORM_FIELDS: FORM_FIELDS,
    HYGIENE_OK: HYGIENE_OK,
    HYGIENE_NG: HYGIENE_NG,
    CONSULT_YES: CONSULT_YES,
    CONSULT_NO: CONSULT_NO,
    isDateString: isDateString,
    normalizeDate: normalizeDate,
    weekdayOf: weekdayOf,
    addDays: addDays,
    previousWeek: previousWeek,
    isOpenOn: isOpenOn,
    parseClosedWeekdays: parseClosedWeekdays,
    reportKey: reportKey,
    normalizeReport: normalizeReport,
    leftoverRate: leftoverRate,
    attentionReasons: attentionReasons,
    findMissingStores: findMissingStores,
    summarizeWeek: summarizeWeek,
    renderWeeklyHtml: renderWeeklyHtml,
    formatPercent: formatPercent,
    escapeHtml: escapeHtml,
    sanitizeCell: sanitizeCell,
  };
}
