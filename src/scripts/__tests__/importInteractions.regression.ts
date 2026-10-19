import Database from 'better-sqlite3';
import fs from 'fs';

describe('CSV interaction provenance', () => {
  it.each([
    ['header-only input', 'Drug 1,Drug 2,Interaction Description\n', false, 'OLD-A'],
    ['empty ingredient', 'Drug 1,Drug 2,Interaction Description\n ,ING-B,description\n', false, 'OLD-A'],
    ['empty description', 'Drug 1,Drug 2,Interaction Description\nING-A,ING-B,  \n', false, 'OLD-A'],
    ['UTF-8 BOM', '\ufeffDrug 1,Drug 2,Interaction Description\nING-A,ING-B,description\n', true, 'ING-A'],
  ])('handles %s without corrupting verified data', async (_label, csv, expectedResult, expectedIngredient) => {
    const realExists = fs.existsSync.bind(fs);
    const realRead = fs.readFileSync.bind(fs);
    const exists = jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
      String(p).endsWith('db_drug_interactions.csv') || realExists(p));
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, opts?: any) =>
      String(p).endsWith('db_drug_interactions.csv') ? csv : realRead(p as any, opts as any)) as any);
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE drug_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_a TEXT NOT NULL, ingredient_b TEXT NOT NULL, severity TEXT,
        description_ar TEXT, description_en TEXT, recommendation TEXT, source TEXT);
        INSERT INTO drug_interactions(ingredient_a,ingredient_b,severity,description_en,source)
        VALUES('OLD-A','OLD-B','major','verified prior CSV','CSV');`);
      jest.resetModules();
      const { importInteractionsFromCSV } = require('@/scripts/importInteractions');
      expect(await importInteractionsFromCSV(db)).toBe(expectedResult);
      expect(db.prepare('SELECT ingredient_a FROM drug_interactions').all())
        .toEqual([{ ingredient_a: expectedIngredient }]);
    } finally { db.close(); exists.mockRestore(); read.mockRestore(); }
  });

  it('rejects an injected or unexpected CSV header before replacing existing verified interactions', async () => {
    const realExists = fs.existsSync.bind(fs);
    const realRead = fs.readFileSync.bind(fs);
    const exists = jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) =>
      String(p).endsWith('db_drug_interactions.csv') || realExists(p));
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, opts?: any) =>
      String(p).endsWith('db_drug_interactions.csv')
        ? '__proto__,Drug 1,Drug 2,Interaction Description\nmalicious,ING-A,ING-B,forged\n'
        : realRead(p as any, opts as any)) as any);
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE drug_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_a TEXT NOT NULL, ingredient_b TEXT NOT NULL, severity TEXT,
        description_ar TEXT, description_en TEXT, recommendation TEXT, source TEXT);
        INSERT INTO drug_interactions(ingredient_a,ingredient_b,severity,description_en,source)
        VALUES('OLD-A','OLD-B','major','trusted original','CSV');`);
      jest.resetModules();
      const { importInteractionsFromCSV } = require('@/scripts/importInteractions');
      expect(await importInteractionsFromCSV(db)).toBe(false);
      expect(db.prepare('SELECT ingredient_a,ingredient_b,description_en,source FROM drug_interactions').all())
        .toEqual([{ ingredient_a:'OLD-A',ingredient_b:'OLD-B',description_en:'trusted original',source:'CSV' }]);
    } finally { db.close(); exists.mockRestore(); read.mockRestore(); }
  });
  it('stores imported rows as CSV even when the existing application schema defaults source to WHO', async () => {
    const realExistsSync = fs.existsSync.bind(fs);
    const realReadFileSync = fs.readFileSync.bind(fs);
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('db_drug_interactions.csv') || realExistsSync(filePath)
    );
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: any) => {
      if (String(filePath).endsWith('db_drug_interactions.csv')) {
        return 'Drug 1,Drug 2,Interaction Description\nING-A,ING-B,CSV interaction\n';
      }
      return realReadFileSync(filePath as any, options as any);
    }) as any);
    jest.resetModules();
    const { importInteractionsFromCSV } = require('@/scripts/importInteractions');

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE drug_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_a TEXT NOT NULL COLLATE NOCASE,
        ingredient_b TEXT NOT NULL COLLATE NOCASE,
        severity TEXT NOT NULL DEFAULT 'minor',
        description_ar TEXT,
        description_en TEXT,
        recommendation TEXT,
        source TEXT DEFAULT 'WHO'
      );
    `);

    expect(await importInteractionsFromCSV(db)).toBe(true);
    expect(
      db.prepare(`
        SELECT ingredient_a, ingredient_b, description_en, severity, source
        FROM drug_interactions
      `).get()
    ).toEqual({
      ingredient_a: 'ING-A',
      ingredient_b: 'ING-B',
      description_en: 'CSV interaction',
      severity: 'major',
      source: 'CSV',
    });

    db.close();
    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('rolls back the entire CSV replacement if a later chunk fails', async () => {
    const rows = Array.from({ length: 5000 }, (_, index) =>
      `A${index},B${index},interaction ${index}`
    );
    rows.push('A0,B0,duplicate that fails in the second chunk');
    const csv = `Drug 1,Drug 2,Interaction Description\n${rows.join('\n')}\n`;

    const realExistsSync = fs.existsSync.bind(fs);
    const realReadFileSync = fs.readFileSync.bind(fs);
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filePath: fs.PathLike) =>
      String(filePath).endsWith('db_drug_interactions.csv') || realExistsSync(filePath)
    );
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor, options?: any) => {
      if (String(filePath).endsWith('db_drug_interactions.csv')) return csv;
      return realReadFileSync(filePath as any, options as any);
    }) as any);
    jest.resetModules();
    const { importInteractionsFromCSV } = require('@/scripts/importInteractions');

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE drug_interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingredient_a TEXT NOT NULL COLLATE NOCASE,
        ingredient_b TEXT NOT NULL COLLATE NOCASE,
        severity TEXT NOT NULL DEFAULT 'minor',
        description_ar TEXT,
        description_en TEXT,
        recommendation TEXT,
        source TEXT DEFAULT 'WHO',
        UNIQUE (ingredient_a, ingredient_b)
      );
      INSERT INTO drug_interactions
        (ingredient_a, ingredient_b, severity, description_en, source)
      VALUES ('OLD-A', 'OLD-B', 'major', 'previous CSV data', 'CSV');
    `);

    expect(await importInteractionsFromCSV(db)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM drug_interactions').get()).toEqual({ count: 1 });
    expect(
      db.prepare(`
        SELECT ingredient_a, ingredient_b, description_en, source
        FROM drug_interactions WHERE source = 'CSV'
      `).get()
    ).toEqual({
      ingredient_a: 'OLD-A',
      ingredient_b: 'OLD-B',
      description_en: 'previous CSV data',
      source: 'CSV',
    });

    db.close();
    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});
