// Read-only timestamp audit: isolated SQLite + simulated clocks; never opens the live database.
const fs = require('fs');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const read = file => fs.readFileSync(file, 'utf8');
const adapter = read('src/lib/db/tauri.ts');
const helper = adapter.slice(adapter.indexOf('const sqliteUtcTimestamp'), adapter.indexOf('async function executeTauri')).replace('export function', 'function');
const js = ts.transpileModule(helper, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const normalize = new Function(js + '; return normalizeDatabaseTimestamps;')();
const timeJs = ts.transpileModule(read('src/lib/time.ts').replaceAll('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const results = [];
const check = (name, expected, actual) => results.push({ name, status: JSON.stringify(expected) === JSON.stringify(actual) ? 'PASS' : 'FAIL', expected, actual });
const dates = ['2026-08-31T21:30:00Z','2026-12-31T23:30:00Z','2024-02-29T00:30:00Z','2026-03-08T06:30:00Z','2026-03-08T07:30:00Z','2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'];
const zones = ['UTC','Africa/Cairo','Europe/Paris','America/New_York','Asia/Kathmandu','Pacific/Kiritimati'];
for (const zone of zones) {
  const output = JSON.parse(execFileSync(process.execPath, ['-e', `
    ${js}
    ${timeJs}
    const dates=${JSON.stringify(dates)};
    console.log(JSON.stringify(dates.map(instant => {
      const raw=instant.replace('T',' ').replace('Z','');
      const row=normalizeDatabaseTimestamps([{created_at:raw,start_time:raw,end_time:raw,occurred_at:raw,date:localDate(new Date(instant)),invoice_date:localDate(new Date(instant))}])[0];
      const local=new Date(instant);
      const localDay=localDate(local);
      return {instant,raw,row,localDay,parsedDay:parseBusinessDate(localDay).getDate(),
        dayNumber:local.getDate(),aliasInstant:new Date(row.occurred_at).toISOString(),defaultDay:localDate(local),
        twice:normalizeDatabaseTimestamps([row])[0]};
    })));`], {encoding:'utf8', env:{...process.env,TZ:zone}}));
  for (const entry of output) {
    check(`UTC roundtrip/idempotence ${zone} ${entry.instant}`, [entry.instant,entry.row], [entry.row.created_at,entry.twice]);
    check(`Statement date alias ${zone} ${entry.instant}`, new Date(entry.instant).toISOString(), entry.aliasInstant);
    check(`Local business-day default ${zone} ${entry.instant}`, entry.localDay, entry.defaultDay);
    check(`Date-only calendar display ${zone} ${entry.localDay}`, entry.dayNumber, entry.parsedDay);
  }
}
for (const input of ['2026-08-22 10:15:30.123','2026-08-22T10:15:30Z','2026-08-22T13:15:30+03:00']) {
  check(`Offset/millisecond instant ${input}`, Date.parse(input.includes('T') ? input : input.replace(' ','T')+'Z'), Date.parse(normalize([{created_at:input}])[0].created_at));
}

const db = new Database(':memory:');
db.exec(`CREATE TABLE sales_invoices(id TEXT,created_at TEXT,total_amount REAL,status TEXT,payment_method TEXT);
  CREATE TABLE returns(created_at TEXT,total_refund REAL,status TEXT);
  INSERT INTO sales_invoices VALUES('midnight','2026-08-31 21:30:00',100,'completed','cash');
  INSERT INTO returns VALUES('2026-08-31 21:45:00',20,'approved');`);
const finance = read('src/app/actions-client/finance.ts');
const dailySales = finance.match(/SELECT COALESCE\(SUM\(total_amount\), 0\) as total FROM sales_invoices WHERE date\(created_at, 'localtime'\) = \? AND status = \?/)[0];
check('Actual finance sales query: Cairo September 1 00:30',100,db.prepare(dailySales.replace("'localtime'","'+03:00'")).get('2026-09-01','completed').total);
const dailyReturns = finance.match(/SELECT COALESCE\(SUM\(total_refund\), 0\) as total FROM returns WHERE date\(created_at, 'localtime'\) = \? AND status = \?/)[0];
check('Actual finance returns query: Cairo September 1 00:45',20,db.prepare(dailyReturns.replace("'localtime'","'+03:00'")).get('2026-09-01','approved').total);
const returnSource=read('src/app/actions-client/returns.ts');
const predicate=returnSource.match(/date\(i.created_at, 'localtime'\) = \?/)[0];
// Only substitute the timezone for deterministic simulation, retaining the actual query predicate.
const selectedDates=['2026-08-31','2026-09-01'].filter(date=>db.prepare(`SELECT id FROM sales_invoices i WHERE ${predicate.replace("'localtime'","'+03:00'")}`).get(date));
check('Return picker assigns a receipt to exactly its local day',['2026-09-01'],selectedDates);
const revenueSql=read('src/app/actions-client/expenses.ts').match(/SELECT COALESCE\(SUM\(total_amount\), 0\) as revenue\s+FROM sales_invoices\s+WHERE strftime\('%Y-%m', created_at, 'localtime'\) = \?/)[0];
check('Actual monthly revenue query: September local sale',100,db.prepare(revenueSql.replace("'localtime'","'+03:00'")).get('2026-09').revenue);
db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,created_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO events DEFAULT VALUES;");
const stored=db.prepare('SELECT created_at FROM events').get().created_at;
check('SQLite current timestamp agrees with system instant within two seconds',true,Math.abs(Date.now()-Date.parse(stored.replace(' ','T')+'Z'))<2000);
db.exec("INSERT INTO events(created_at) VALUES('2026-11-01 05:30:00'),('2026-11-01 06:30:00');");
check('DST repeated hour remains two distinct UTC instants',true,normalize(db.prepare('SELECT created_at FROM events WHERE id>1').all())[0].created_at !== normalize(db.prepare('SELECT created_at FROM events WHERE id>1').all())[1].created_at);
db.close();
console.log(JSON.stringify({ summary:{ total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length }, results:process.argv.includes('--summary') ? results.filter(r=>r.status==='FAIL').slice(-6) : results },null,2));
process.exitCode=results.some(r=>r.status==='FAIL') ? 1 : 0;
