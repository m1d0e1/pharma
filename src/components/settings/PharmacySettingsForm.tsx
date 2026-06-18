'use client';

import React, { useState } from 'react';
import { updatePharmacyClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';

interface PharmacySettingsFormProps {
  pharmacy: any;
}

export default function PharmacySettingsForm({ pharmacy: rawPharmacy }: PharmacySettingsFormProps) {
  const pharmacy = Array.isArray(rawPharmacy) ? rawPharmacy[0] : rawPharmacy;
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const data = Object.fromEntries(formData.entries());

    const result = await updatePharmacyClient(data);

    if (result.success) {
      toast.success('تم تحديث بيانات الصيدلية بنجاح');
    } else {
      toast.error(result.error || 'فشل تحديث البيانات');
    }
    setLoading(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-10">
      {/* 1. Basic Info */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
        <div className="flex items-center gap-3 mb-8 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center text-blue-600">🏢</div>
          <h3 className="text-xl font-bold">بيانات الصيدلية الأساسية</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">الإسم (بالعربية)</label>
            <input 
              name="name"
              type="text" 
              defaultValue={pharmacy?.name}
              required
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">الإسم (English)</label>
            <input 
              name="name_en"
              type="text" 
              defaultValue={pharmacy?.name_en}
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">التليفون</label>
            <input 
              name="phone"
              type="text" 
              defaultValue={pharmacy?.phone}
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">العنوان بالتفصيل</label>
            <input 
              name="address"
              type="text" 
              defaultValue={pharmacy?.address}
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 2. Commercial Info */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
        <div className="flex items-center gap-3 mb-8 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center text-emerald-600">📜</div>
          <h3 className="text-xl font-bold">البيانات التجارية</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">رقم السجل التجاري</label>
            <input 
              name="commercial_registry"
              type="text" 
              defaultValue={pharmacy?.commercial_registry}
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-400 mr-2 uppercase">رقم البطاقة الضريبية</label>
            <input 
              name="tax_card"
              type="text" 
              defaultValue={pharmacy?.tax_card}
              className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* 3. Owner & Manager Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Owner Info */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <div className="flex items-center gap-3 mb-8 border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-xl flex items-center justify-center text-purple-600">👤</div>
            <h3 className="text-xl font-bold">بيانات المالك</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-400 mr-2 uppercase">إسم المالك</label>
              <input name="owner_name" type="text" defaultValue={pharmacy?.owner_name} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-purple-500" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-400 mr-2 uppercase">العنوان</label>
              <input name="owner_address" type="text" defaultValue={pharmacy?.owner_address} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-purple-500" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase">التليفون</label>
                <input name="owner_phone" type="text" defaultValue={pharmacy?.owner_phone} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-purple-500" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase">الموبايل</label>
                <input name="owner_mobile" type="text" defaultValue={pharmacy?.owner_mobile} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-purple-500" />
              </div>
            </div>
          </div>
        </div>

        {/* Manager Info */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <div className="flex items-center gap-3 mb-8 border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-xl flex items-center justify-center text-orange-600">👔</div>
            <h3 className="text-xl font-bold">بيانات المدير العام</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-400 mr-2 uppercase">إسم المدير</label>
              <input name="manager_name" type="text" defaultValue={pharmacy?.manager_name} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-orange-500" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-400 mr-2 uppercase">العنوان</label>
              <input name="manager_address" type="text" defaultValue={pharmacy?.manager_address} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-orange-500" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase">التليفون</label>
                <input name="manager_phone" type="text" defaultValue={pharmacy?.manager_phone} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-orange-500" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-400 mr-2 uppercase">الموبايل</label>
                <input name="manager_mobile" type="text" defaultValue={pharmacy?.manager_mobile} className="w-full bg-slate-50 dark:bg-slate-800 border-none p-4 rounded-2xl font-bold outline-none focus:ring-2 focus:ring-orange-500" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl border border-slate-200 dark:border-slate-800">
        <p className="text-slate-500 text-sm font-bold">* يرجى التأكد من صحة البيانات المدخلة لأغراض الفواتير والتقارير القانونية.</p>
        <button 
          disabled={loading}
          className="bg-blue-600 text-white px-12 py-4 rounded-2xl font-black shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? 'جاري الحفظ...' : 'حفظ البيانات'}
          {!loading && <span>💾</span>}
        </button>
      </div>
    </form>
  );
}
