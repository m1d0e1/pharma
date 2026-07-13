'use client';

import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { dbExecute, dbTransaction, dbGet } from '@/lib/db/tauri';

export default function InteractionsSyncButton() {
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const supabase = getSupabaseBrowserClient();

      // Ensure sync_metadata table exists
      await dbExecute(`
        CREATE TABLE IF NOT EXISTS sync_metadata (
          table_name TEXT PRIMARY KEY,
          last_synced_at TEXT
        )
      `);

      const intSyncRow = await dbGet('SELECT last_synced_at FROM sync_metadata WHERE table_name = ?', ['cloud_drug_interactions']) as any;
      const lastIntSync = intSyncRow?.last_synced_at || '1970-01-01T00:00:00Z';
      const nowSyncTime = new Date().toISOString();

      console.log(`Fetching interactions updated after ${lastIntSync}...`);

      let allInteractions: any[] = [];
      let from = 0;
      const batchSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: batch, error } = await supabase
          .from('cloud_drug_interactions')
          .select('*')
          .gt('updated_at', lastIntSync)
          .order('id', { ascending: true })
          .range(from, from + batchSize - 1);

        if (error) {
          console.error('Interactions fetch error:', error);
          toast.error('فشل في جلب التفاعلات من السحابة');
          return;
        }

        if (batch && batch.length > 0) {
          allInteractions = [...allInteractions, ...batch];
          from += batchSize;
          if (batch.length < batchSize) hasMore = false;
        } else {
          hasMore = false;
        }
      }

      console.log(`Fetched ${allInteractions.length} new/updated interactions.`);

      if (allInteractions.length > 0) {
        console.log(`Inserting ${allInteractions.length} interactions in batches...`);
        const batchSize = 200;
        for (let i = 0; i < allInteractions.length; i += batchSize) {
          const chunk = allInteractions.slice(i, i + batchSize);
          const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
          const sql = `
            INSERT INTO drug_interactions (ingredient_a, ingredient_b, description_en)
            VALUES ${placeholders}
            ON CONFLICT(ingredient_a, ingredient_b) DO UPDATE SET
              description_en = excluded.description_en
          `;
          const params: any[] = [];
          for (const inter of chunk) {
            params.push(
              inter.drug_1,
              inter.drug_2,
              inter.interaction_description
            );
          }
          await dbExecute(sql, params);
        }
      }

      await dbExecute(
        'INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)',
        ['cloud_drug_interactions', nowSyncTime]
      );

      toast.success(`تم تحديث التفاعلات بنجاح. ${allInteractions.length} تفاعل جديد/محدث.`);
    } catch (err) {
      console.error('InteractionsSyncButton error:', err);
      toast.error('خطأ في مزامنة التفاعلات');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      className={`
        relative overflow-hidden group px-6 py-3 rounded-2xl font-black text-sm transition-all duration-500
        flex items-center gap-3 shadow-xl
        ${syncing
          ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
          : 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:shadow-purple-500/30 hover:-translate-y-1 active:scale-95'}
      `}
    >
      {syncing ? (
        <>
          <Zap className="w-4 h-4 animate-pulse" />
          <span>جاري تحديث التفاعلات...</span>
        </>
      ) : (
        <>
          <div className="relative">
            <Zap className="w-4 h-4 group-hover:scale-125 transition-transform duration-300" />
            <div className="absolute inset-0 bg-white/20 blur-md rounded-full scale-150 opacity-0 group-hover:opacity-100 transition-opacity"></div>
          </div>
          <span>تحديث التفاعلات الدوائية</span>
        </>
      )}
    </button>
  );
}
