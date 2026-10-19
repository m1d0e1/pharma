/** @jest-environment node */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

describe('forward-only payment provenance and expense replay migrations',()=>{
  it('preserves legacy unowned patient transactions and historical expense rows unchanged',()=>{
    const db=new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE patients(id TEXT PRIMARY KEY, full_name TEXT,opening_balance REAL);
        CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,type TEXT,amount REAL);
        CREATE TABLE expenses(id TEXT PRIMARY KEY,user_id TEXT,category TEXT,amount REAL);
        INSERT INTO patients VALUES('legacy-shared','Shared',100);
        INSERT INTO patient_transactions VALUES('legacy-payment','legacy-shared','payment',20);
        INSERT INTO expenses VALUES('legacy-expense','old-user','UTIL',10);
      `);
      const beforePayment=db.prepare('SELECT * FROM patient_transactions').all();
      const beforeExpense=db.prepare('SELECT * FROM expenses').all();
      for(const filename of ['033_patient_payment_scope.sql','034_expense_posting_requests.sql',
        '035_commercial_paper_replay.sql']) {
        db.exec(fs.readFileSync(path.join(process.cwd(),'src-tauri','migrations',filename),'utf8'));
      }
      expect(db.prepare('SELECT * FROM patient_transactions').all()).toEqual(beforePayment);
      expect(db.prepare('SELECT * FROM expenses').all()).toEqual(beforeExpense);
      expect(db.prepare('SELECT * FROM patient_payment_scope').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM expense_posting_requests').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM commercial_paper_create_requests').all()).toEqual([]);
      db.prepare('INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id) VALUES(?,?,?)')
        .run('legacy-payment','branch-a','request-once');
      expect(()=>db.prepare('INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id) VALUES(?,?,?)')
        .run('legacy-payment','branch-b','request-twice')).toThrow();
      expect(()=>db.prepare('INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id) VALUES(?,?,?)')
        .run('new-payment','branch-b','request-once')).toThrow();
      db.prepare('INSERT INTO expense_posting_requests(request_id,expense_id,pharmacy_id) VALUES(?,?,?)')
        .run('expense-once','legacy-expense','branch-a');
      expect(()=>db.prepare('INSERT INTO expense_posting_requests(request_id,expense_id,pharmacy_id) VALUES(?,?,?)')
        .run('expense-once','new-expense','branch-a')).toThrow();
      db.prepare('INSERT INTO commercial_paper_create_requests(request_id,paper_id,pharmacy_id) VALUES(?,?,?)')
        .run('paper-request','created-paper','branch-a');
      expect(()=>db.prepare('INSERT INTO commercial_paper_create_requests(request_id,paper_id,pharmacy_id) VALUES(?,?,?)')
        .run('paper-request','another-paper','branch-a')).toThrow();
      expect(()=>db.prepare('INSERT INTO commercial_paper_create_requests(request_id,paper_id,pharmacy_id) VALUES(?,?,?)')
        .run('second-request','created-paper','branch-b')).toThrow();
    } finally {db.close();}
  });
});

describe('financial-notice provenance migration does not claim legacy ownership',()=>{
  it('retains old notices and patient transactions byte-for-byte while protecting new nonces',()=>{
    const db=new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE financial_notices(id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,amount REAL);
        CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,type TEXT,amount REAL);
        INSERT INTO financial_notices VALUES('legacy-notice','customer','unknown-patient',15);
        INSERT INTO patient_transactions VALUES('legacy-adjustment','unknown-patient','adjustment',15);
      `);
      const oldNotices=db.prepare('SELECT * FROM financial_notices').all();
      const oldTransactions=db.prepare('SELECT * FROM patient_transactions').all();
      db.exec(fs.readFileSync(path.join(process.cwd(),'src-tauri/migrations/036_financial_notice_provenance.sql'),'utf8'));
      expect(db.prepare('SELECT * FROM financial_notices').all()).toEqual(oldNotices);
      expect(db.prepare('SELECT * FROM patient_transactions').all()).toEqual(oldTransactions);
      expect(db.prepare('SELECT * FROM financial_notice_native_scope').all()).toEqual([]);
      db.prepare('INSERT INTO financial_notices(id,target_type,target_id,amount) VALUES(?,?,?,?)')
        .run('native-notice','customer','branch-a-patient',15);
      db.prepare('INSERT INTO patient_transactions(id,patient_id,type,amount) VALUES(?,?,?,?)')
        .run('native-adjustment','branch-a-patient','adjustment',15);
      db.prepare('INSERT INTO financial_notice_native_scope (notice_id,pharmacy_id,request_id,patient_transaction_id) VALUES(?,?,?,?)')
        .run('native-notice','branch-a','once','native-adjustment');
      expect(()=>db.prepare('INSERT INTO financial_notice_native_scope (notice_id,pharmacy_id,request_id) VALUES(?,?,?)')
        .run('another','branch-b','once')).toThrow();
      expect(()=>db.prepare('INSERT INTO financial_notice_native_scope (notice_id,pharmacy_id,request_id,patient_transaction_id) VALUES(?,?,?,?)')
        .run('another','branch-b','twice','native-adjustment')).toThrow();
    }finally{db.close();}
  });
});

describe('finance device creation nonce migration preserves historic banks and cards',()=>{
  it('leaves legacy directory balances untouched and blocks bank/card/POS replays across kinds',()=>{
    const db=new Database(':memory:');
    try{
      db.exec(`
        CREATE TABLE banks(id INTEGER PRIMARY KEY,name_ar TEXT,current_balance REAL);
        CREATE TABLE credit_cards(id INTEGER PRIMARY KEY,name_ar TEXT,current_balance REAL);
        CREATE TABLE points_of_sale(id INTEGER PRIMARY KEY,name_ar TEXT,current_balance REAL);
        INSERT INTO banks VALUES(11,'Historic bank',500.20);
        INSERT INTO credit_cards VALUES(14,'Historic terminal',50.00);
        INSERT INTO points_of_sale VALUES(17,'Historic POS',0);
      `);
      const before={
        banks:db.prepare('SELECT * FROM banks').all(),
        cards:db.prepare('SELECT * FROM credit_cards').all(),
        terminals:db.prepare('SELECT * FROM points_of_sale').all(),
      };
      db.exec(fs.readFileSync(path.join(process.cwd(),
        'src-tauri/migrations/037_finance_device_create_requests.sql'),'utf8'));
      expect(db.prepare('SELECT * FROM banks').all()).toEqual(before.banks);
      expect(db.prepare('SELECT * FROM credit_cards').all()).toEqual(before.cards);
      expect(db.prepare('SELECT * FROM points_of_sale').all()).toEqual(before.terminals);
      expect(db.prepare('SELECT * FROM finance_device_create_requests').all()).toEqual([]);
      db.prepare('INSERT INTO finance_device_create_requests(request_id,kind,record_id,pharmacy_id) VALUES(?,?,?,?)')
        .run('same-request','pos',17,'branch-a');
      db.prepare('DELETE FROM points_of_sale WHERE id=?').run(17);
      expect(()=>db.prepare('INSERT INTO finance_device_create_requests(request_id,kind,record_id,pharmacy_id) VALUES(?,?,?,?)')
        .run('same-request','bank',11,'branch-b')).toThrow();
      expect(()=>db.prepare('INSERT INTO finance_device_create_requests(request_id,kind,record_id,pharmacy_id) VALUES(?,?,?,?)')
        .run('some-request','fraudulent-kind',11,'branch-a')).toThrow();
      expect(db.prepare('SELECT request_id,kind,record_id FROM finance_device_create_requests').get())
        .toEqual({request_id:'same-request',kind:'pos',record_id:17});
    }finally{db.close();}
  });
});
