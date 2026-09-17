// Scrapes the university timetable page and writes schedule.json in the
// format the Домашка app expects. Meant to run on a schedule via
// GitHub Actions (see .github/workflows/update-schedule.yml), but you
// can also run it locally:
//
//   npm install puppeteer
//   node scripts/scrape-schedule.js
//
// IMPORTANT — this is a first version. It was written without being able
// to test against the live site (the site blocks automated fetches from
// outside a real browser, and that includes the sandbox this was written
// in). It uses a real headless Chrome (via Puppeteer) so it should look
// like a normal visitor, and it always saves debug-page.html next to
// schedule.json so mistakes are easy to diagnose. If the first run
// doesn't produce a correct schedule.json, send back debug-page.html
// (or just the Action's log) and the parsing logic below can be fixed
// to match the real page structure.

const fs = require("fs");
const path = require("path");

const TARGET_URL =
  process.env.TIMETABLE_URL ||
  "https://sibstrin.ru/timetable/group/";
const GROUP_NAME = process.env.TIMETABLE_GROUP_NAME || "128";

const TIMES = [
  "08:30-10:00", "10:15-11:45", "12:00-13:30", "14:10-15:35",
  "15:45-17:10", "17:20-18:45", "18:50-20:15", "20:20-21:50"
];
const DAY_WORDS = { "пн": 0, "понедельник": 0, "вт": 1, "вторник": 1, "ср": 2, "среда": 2, "чт": 3, "четверг": 3, "пт": 4, "пятница": 4, "сб": 5, "суббота": 5 };

function classifyLines(lines) {
  var out = { groups: "", subject: "", teacher: "", room: "" };
  lines.forEach(function (raw) {
    var l = raw.trim();
    if (!l) return;
    if (/^[\d\s,()]+гр\.?$/i.test(l) && !out.groups) { out.groups = l; return; }
    if ((/^(лек|пр|лаб)\.?\s*\/.*ауд/i.test(l) || /ауд\.?$/i.test(l)) && !out.room) { out.room = l; return; }
    if (/^[А-ЯЁ][а-яё]+(\s+[А-ЯЁ]\.){1,2}\s*$/.test(l) && out.subject && !out.teacher) { out.teacher = l; return; }
    out.subject = out.subject ? out.subject + " " + l : l;
  });
  return out;
}

function emptyPart() { return { groups: "", subject: "", teacher: "", room: "" }; }
function emptyWeeks() {
  var weeks = [{ days: [] }, { days: [] }];
  for (var w = 0; w < 2; w++) {
    for (var d = 0; d < 6; d++) {
      weeks[w].days.push({ date: "", slots: TIMES.map(function () { return { split: false, parts: [emptyPart()] }; }) });
    }
  }
  return weeks;
}

async function run() {
  // puppeteer-extra + stealth plugin masks common automation fingerprints
  // (navigator.webdriver, missing plugins/mimeTypes, odd permissions
  // behavior, etc.) that bot-detection systems commonly check for -
  // plain Puppeteer is trivially detectable by those checks.
  const puppeteer = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteer.use(StealthPlugin());
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1400, height: 1000 });

  console.log("Opening", TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Some sites show a one-time "confirm you're not a robot" / "continue"
  // button to automated browsers even without a real captcha. Try clicking
  // anything that looks like that, a few times, before giving up.
  async function tryDismissGate() {
    return page.evaluate(function () {
      var keywordRe = /(не робот|я человек|подтвердить|продолжить|войти|verify|i am human|i'm not a robot|continue|confirm|accept|соглас)/i;
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], label, span, div')
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.innerText || el.value || "").trim();
        if (text && text.length < 60 && keywordRe.test(text)) {
          el.click();
          return text;
        }
      }
      // Fallback: a lone checkbox with no matching label text nearby
      // (common for lightweight "I'm not a robot" gates).
      var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]'));
      if (boxes.length === 1 && !boxes[0].checked) {
        boxes[0].click();
        return "(checkbox)";
      }
      return null;
    });
  }

  await tryDismissGate();
  await new Promise(function (r) { setTimeout(r, 500); });

  // The site expects a real form submission: pick the group from the
  // "Учебная группа" dropdown by its visible text (works for ANY group,
  // not just one hardcoded id), then click "Показать".
  async function selectGroupAndSubmit(groupName) {
    var selected = await page.evaluate(function (name) {
      var selects = Array.prototype.slice.call(document.querySelectorAll("select"));
      for (var i = 0; i < selects.length; i++) {
        var sel = selects[i];
        var opts = Array.prototype.slice.call(sel.options);
        var match = opts.filter(function (o) { return o.textContent.trim() === name; })[0];
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, groupName);

    if (!selected) return false;

    return page.evaluate(function () {
      var candidates = Array.prototype.slice.call(
        document.querySelectorAll('button, input[type="submit"], a')
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var text = (el.innerText || el.value || "").trim();
        if (/показать/i.test(text)) { el.click(); return true; }
      }
      var anySelect = document.querySelector("select");
      var form = anySelect ? anySelect.closest("form") : null;
      if (form) { form.submit(); return true; }
      return false;
    });
  }


  console.log("Selecting group '" + GROUP_NAME + "' in the form...");
  var formOk = await selectGroupAndSubmit(GROUP_NAME);
  if (!formOk) {
    console.log("Could not find/select group '" + GROUP_NAME + "' in the dropdown, or no submit button/form found.");
  } else {
    await new Promise(function (r) { setTimeout(r, 1500); });
  }

  var tableFound = false;
  for (var attempt = 0; attempt < 3 && !tableFound; attempt++) {
    try {
      await page.waitForSelector("table", { timeout: 15000 });
      tableFound = true;
    } catch (e) {
      var clickedText = await tryDismissGate();
      if (clickedText) {
        console.log('Attempt ' + (attempt + 1) + ': no table yet, clicked a button that said "' + clickedText + '", trying again.');
        await new Promise(function (r) { setTimeout(r, 2000); });
      } else {
        console.log("Attempt " + (attempt + 1) + ": no table yet, and nothing obvious to click.");
        break;
      }
    }
  }

  if (!tableFound) {
    // Print a visible snippet of whatever IS on the page, straight into the
    // Action log, so this can be diagnosed from the log screenshot alone -
    // no need to download and unzip the debug-page.html artifact.
    var bodySnippet = await page.evaluate(function () {
      return (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600);
    });
    console.log("No <table> appeared. Visible page text right now:");
    console.log(bodySnippet || "(page body is empty)");
  }

  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, "..", "debug-page.html"), html);

  // Extract every table on the page as a rowspan/colspan-aware grid of
  // plain text cells, so split (subgroup) cells land in the right place
  // without any text-heuristic guessing.
  const tables = await page.evaluate(function () {
    function gridFromTable(table) {
      var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
      var grid = [];
      var pending = [];
      rows.forEach(function (tr, rIdx) {
        grid[rIdx] = grid[rIdx] || [];
        pending.forEach(function (p) { if (p.remaining > 0) grid[rIdx][p.col] = p.text; });
        var col = 0;
        var newPending = [];
        var cells = Array.prototype.slice.call(tr.children);
        cells.forEach(function (td) {
          while (grid[rIdx][col] !== undefined) col++;
          var rowspan = parseInt(td.getAttribute("rowspan") || "1", 10);
          var colspan = parseInt(td.getAttribute("colspan") || "1", 10);
          var text = td.innerText || td.textContent || "";
          for (var cs = 0; cs < colspan; cs++) {
            grid[rIdx][col + cs] = text;
            if (rowspan > 1) newPending.push({ col: col + cs, remaining: rowspan - 1, text: text });
          }
          col += colspan;
        });
        pending.forEach(function (p) { p.remaining--; });
        pending = pending.filter(function (p) { return p.remaining > 0; }).concat(newPending);
      });
      return grid;
    }
    return Array.prototype.slice.call(document.querySelectorAll("table")).map(gridFromTable);
  });

  await browser.close();

  // Pick the table that actually looks like the timetable: several time
  // ranges in the header area and several day names in the left column.
  var best = null;
  for (var t = 0; t < tables.length; t++) {
    var grid = tables[t];
    var headerText = (grid[0] || []).join(" ").toLowerCase();
    var leftColText = grid.map(function (r) { return (r[0] || "") + " " + (r[1] || ""); }).join(" ").toLowerCase();
    var timeHits = (headerText.match(/\d{1,2}[:.]\d{2}/g) || []).length;
    var dayHits = Object.keys(DAY_WORDS).filter(function (d) { return leftColText.indexOf(d) !== -1; }).length;
    if (timeHits >= 4 && dayHits >= 3) { best = grid; break; }
  }

  if (!best) {
    console.error("Could not find a table that looks like the timetable. See debug-page.html for what the page actually rendered.");
    process.exit(1);
  }

  var weeks = emptyWeeks();
  var curWeek = 0, curDay = -1;

  best.forEach(function (row) {
    var first = (row[0] || "").trim().toLowerCase();
    if (/^\d+\s*недел/.test(first)) { curWeek = /^2/.test(first) ? 1 : 0; curDay = -1; return; }

    var dayMatch = Object.keys(DAY_WORDS).filter(function (d) { return first.indexOf(d) === 0; })[0];
    if (dayMatch !== undefined) {
      curDay = DAY_WORDS[dayMatch];
      var dm = row.join(" ").match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if (dm) weeks[curWeek].days[curDay].date = dm[0];
    }
    if (curDay < 0) return;

    // Assume the last 8 columns of the row are the 8 time slots.
    var dataCols = row.slice(Math.max(0, row.length - TIMES.length));
    dataCols.forEach(function (cellText, i) {
      if (i >= 8 || !cellText) return;
      var lines = cellText.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!lines.length) return;
      var parsed = classifyLines(lines);
      if (!parsed.subject && !parsed.groups) return;
      var slot = weeks[curWeek].days[curDay].slots[i];
      var firstEmpty = !slot.parts[0].subject && !slot.parts[0].groups;
      if (firstEmpty) {
        slot.parts[0] = parsed;
      } else if (slot.parts[0].subject !== parsed.subject || slot.parts[0].teacher !== parsed.teacher) {
        slot.split = true;
        slot.parts[1] = parsed;
      }
    });
  });

  await writeToSupabase(weeks);
  console.log("Wrote schedule to Supabase");
}

// ---------- Supabase (written via plain REST + service role key, no SDK needed) ----------

var SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, options) {
  options = options || {};
  var headers = Object.assign({
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json"
  }, options.headers || {});
  var res = await fetch(SUPABASE_URL + path, Object.assign({}, options, { headers: headers }));
  if (!res.ok) {
    var body = await res.text();
    throw new Error("Supabase " + path + " -> " + res.status + ": " + body);
  }
  var text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function writeToSupabase(weeks) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (as GitHub Actions secrets).");
  }

  var groups = await sbFetch("/rest/v1/groups?name=eq." + encodeURIComponent(GROUP_NAME) + "&select=id");
  if (!groups || !groups.length) {
    throw new Error("Group '" + GROUP_NAME + "' does not exist in Supabase yet. Create it first (insert into groups).");
  }
  var groupId = groups[0].id;

  // Upsert every distinct teacher name we saw, and build name -> id.
  var teacherNames = {};
  weeks.forEach(function (w) { w.days.forEach(function (d) { d.slots.forEach(function (s) {
    s.parts.forEach(function (p) { if (p.teacher) teacherNames[p.teacher] = true; });
  }); }); });

  var teacherIdByName = {};
  var names = Object.keys(teacherNames);
  for (var i = 0; i < names.length; i++) {
    var rows = await sbFetch(
      "/rest/v1/teachers?on_conflict=group_id,full_name",
      {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ group_id: groupId, full_name: names[i] })
      }
    );
    if (rows && rows[0]) teacherIdByName[names[i]] = rows[0].id;
  }

  // Upsert every slot, tracking which (week,day,slot,part) combos we touched
  // so anything left over from a previous scrape (a lesson that no longer
  // exists) can be cleaned up afterwards.
  var touched = {};
  for (var w = 0; w < weeks.length; w++) {
    for (var d = 0; d < weeks[w].days.length; d++) {
      var day = weeks[w].days[d];
      for (var s = 0; s < day.slots.length; s++) {
        var slot = day.slots[s];
        for (var pi = 0; pi < slot.parts.length; pi++) {
          var part = slot.parts[pi];
          if (!part.subject && !part.groups) continue;
          var key = (w + 1) + ":" + d + ":" + s + ":" + pi;
          touched[key] = true;
          await sbFetch(
            "/rest/v1/schedule_slots?on_conflict=group_id,week_number,day_index,slot_index,part_index",
            {
              method: "POST",
              headers: { "Prefer": "resolution=merge-duplicates" },
              body: JSON.stringify({
                group_id: groupId,
                week_number: w + 1,
                day_index: d,
                slot_index: s,
                part_index: pi,
                lesson_date: day.date ? isoDate(day.date) : null,
                subject: part.subject || null,
                teacher_id: part.teacher ? (teacherIdByName[part.teacher] || null) : null,
                room: part.room || null,
                groups_label: part.groups || null,
                updated_at: new Date().toISOString()
              })
            }
          );
        }
      }
    }
  }

  // Remove slots that used to exist for this group but weren't seen this run.
  var existing = await sbFetch(
    "/rest/v1/schedule_slots?group_id=eq." + groupId + "&select=id,week_number,day_index,slot_index,part_index"
  );
  var staleIds = (existing || [])
    .filter(function (r) {
      var key = r.week_number + ":" + r.day_index + ":" + r.slot_index + ":" + r.part_index;
      return !touched[key];
    })
    .map(function (r) { return r.id; });

  for (var si = 0; si < staleIds.length; si++) {
    await sbFetch("/rest/v1/schedule_slots?id=eq." + staleIds[si], { method: "DELETE" });
  }

  console.log("Upserted " + Object.keys(touched).length + " slots, removed " + staleIds.length + " stale ones.");
}

function isoDate(ddmmyyyy) {
  var m = ddmmyyyy.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
}

if (require.main === module) {
  run().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { writeToSupabase, isoDate, classifyLines };
