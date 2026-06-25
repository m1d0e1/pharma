import { dbExecute, generateId } from '@/lib/db/tauri';
import { hashPassword } from '@/lib/auth/local';

export async function generateSyntheticData(scale: 'small' | 'large' = 'small') {
  console.log(`Generating ${scale} synthetic data...`);
  
  const counts = scale === 'small' ? {
    drugs: 50,
    suppliers: 10,
    patients: 20,
    purchases: 30,
    sales: 100
  } : {
    drugs: 5000,
    suppliers: 100,
    patients: 1000,
    purchases: 2000,
    sales: 10000
  };

  try {
    // 1. Generate Master Drugs
    for (let i = 0; i < counts.drugs; i++) {
      await dbExecute(
        `INSERT OR IGNORE INTO master_drugs (id, trade_name, barcode, active_ingredients, manufacturer, category, official_price) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          i + 1, 
          `SynthDrug_${i}`, 
          `BAR${String(i).padStart(8, '0')}`, 
          `ActiveIng_${i}`, 
          `Manu_${i % 5}`, 
          `Cat_${i % 3}`, 
          (Math.random() * 500).toFixed(2)
        ]
      );
    }
    console.log(`✅ Generated ${counts.drugs} drugs`);

    // 2. Generate Suppliers
    for (let i = 0; i < counts.suppliers; i++) {
      await dbExecute(
        `INSERT OR IGNORE INTO suppliers (id, name_ar, name_en, phone, balance) VALUES (?, ?, ?, ?, ?)`,
        [i + 1, `مورد_${i}`, `Supplier_${i}`, `010000${i}`, (Math.random() * 10000).toFixed(2)]
      );
    }
    console.log(`✅ Generated ${counts.suppliers} suppliers`);

    // 3. Generate Patients
    for (let i = 0; i < counts.patients; i++) {
      await dbExecute(
        `INSERT OR IGNORE INTO patients (id, full_name, phone, credit_limit, wallet_balance) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), `مريض_${i}`, `012000${i}`, 5000, 0]
      );
    }
    console.log(`✅ Generated ${counts.patients} patients`);

    return { success: true };
  } catch (err: any) {
    console.error('Synthetic data generation failed:', err);
    return { success: false, error: err.message };
  }
}
