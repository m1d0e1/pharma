'use client';

import React, { useEffect, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';
import ShortagesClient from "./ShortagesClient";

export default function ShortagesPage() {
  const [shortages, setShortages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadShortages() {
      try {
        const data = await dbSelect(`
          SELECT s.*, 
                 m.trade_name, m.trade_name_en,
                 m.generic_name
          FROM shortages s
          JOIN master_drugs m ON s.drug_id = m.id
          WHERE s.status != 'received'
          ORDER BY s.created_at DESC
        `);
        setShortages(data);
      } catch (err) {
        console.error('Failed to load shortages:', err);
      } finally {
        setLoading(false);
      }
    }
    loadShortages();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <ShortagesClient 
      initialData={shortages} 
    />
  );
}
