'use client';

import React, { useRef, useState } from 'react';
import { updatePharmacyClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';
import { Building2, FileText, UserRound, Briefcase, Save } from 'lucide-react';

interface PharmacySettingsFormProps {
  pharmacy: any;
}

export default function PharmacySettingsForm({ pharmacy: rawPharmacy }: PharmacySettingsFormProps) {
  const pharmacy = Array.isArray(rawPharmacy) ? rawPharmacy[0] : rawPharmacy;
  const [loading, setLoading] = useState(false);
  const savingRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const data = Object.fromEntries(formData.entries());

    try {
      const result = await updatePharmacyClient(data);

      if (result.success) {
        toast.success('تم تحديث بيانات الصيدلية بنجاح');
      } else {
        toast.error(result.error || 'فشل تحديث البيانات');
      }
    } catch {
      toast.error('فشل تحديث البيانات');
    } finally {
      savingRef.current = false;
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 1. Basic Info */}
      <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-3 mb-5 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="w-10 h-10 bg-blue-50 dark:bg-blue-950/30 rounded-lg flex items-center justify-center text-blue-600"><Building2 className="h-5 w-5" /></div>
          <h3 className="text-lg font-semibold">بيانات الصيدلية الأساسية</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label htmlFor="pharmacy-name" className="text-xs font-black text-slate-500 mr-2">الإسم (بالعربية)</label>
            <input 
              id="pharmacy-name"
              name="name"
              type="text" 
              defaultValue={pharmacy?.name}
              required
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="pharmacy-name-en" className="text-xs font-black text-slate-500 mr-2">الإسم (English)</label>
            <input 
              id="pharmacy-name-en"
              name="name_en"
              type="text" 
              defaultValue={pharmacy?.name_en}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="pharmacy-phone" className="text-xs font-black text-slate-500 mr-2">التليفون</label>
            <input 
              id="pharmacy-phone"
              name="phone"
              type="text" 
              defaultValue={pharmacy?.phone}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="pharmacy-address" className="text-xs font-black text-slate-500 mr-2">العنوان بالتفصيل</label>
            <input 
              id="pharmacy-address"
              name="address"
              type="text" 
              defaultValue={pharmacy?.address}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* 2. Commercial Info */}
      <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="flex items-center gap-3 mb-5 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg flex items-center justify-center text-emerald-600"><FileText className="h-5 w-5" /></div>
          <h3 className="text-lg font-semibold">البيانات التجارية</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label htmlFor="commercial-registry" className="text-xs font-black text-slate-500 mr-2">رقم السجل التجاري</label>
            <input 
              id="commercial-registry"
              name="commercial_registry"
              type="text" 
              defaultValue={pharmacy?.commercial_registry}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tax-card" className="text-xs font-black text-slate-500 mr-2">رقم البطاقة الضريبية</label>
            <input 
              id="tax-card"
              name="tax_card"
              type="text" 
              defaultValue={pharmacy?.tax_card}
              className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* 3. Owner & Manager Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Owner Info */}
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="flex items-center gap-3 mb-5 border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="w-10 h-10 bg-purple-50 dark:bg-purple-950/30 rounded-lg flex items-center justify-center text-purple-600"><UserRound className="h-5 w-5" /></div>
            <h3 className="text-lg font-semibold">بيانات المالك</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="owner-name" className="text-xs font-black text-slate-500 mr-2">إسم المالك</label>
              <input id="owner-name" name="owner_name" type="text" defaultValue={pharmacy?.owner_name} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="owner-address" className="text-xs font-black text-slate-500 mr-2">العنوان</label>
              <input id="owner-address" name="owner_address" type="text" defaultValue={pharmacy?.owner_address} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="owner-phone" className="text-xs font-black text-slate-500 mr-2">التليفون</label>
                <input id="owner-phone" name="owner_phone" type="text" defaultValue={pharmacy?.owner_phone} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="owner-mobile" className="text-xs font-black text-slate-500 mr-2">الموبايل</label>
                <input id="owner-mobile" name="owner_mobile" type="text" defaultValue={pharmacy?.owner_mobile} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500" />
              </div>
            </div>
          </div>
        </div>

        {/* Manager Info */}
        <div className="bg-white dark:bg-slate-900 p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div className="flex items-center gap-3 mb-5 border-b border-slate-100 dark:border-slate-800 pb-4">
            <div className="w-10 h-10 bg-orange-50 dark:bg-orange-950/30 rounded-lg flex items-center justify-center text-orange-600"><Briefcase className="h-5 w-5" /></div>
            <h3 className="text-lg font-semibold">بيانات المدير العام</h3>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="manager-name" className="text-xs font-black text-slate-500 mr-2">إسم المدير</label>
              <input id="manager-name" name="manager_name" type="text" defaultValue={pharmacy?.manager_name} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="manager-address" className="text-xs font-black text-slate-500 mr-2">العنوان</label>
              <input id="manager-address" name="manager_address" type="text" defaultValue={pharmacy?.manager_address} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label htmlFor="manager-phone" className="text-xs font-black text-slate-500 mr-2">التليفون</label>
                <input id="manager-phone" name="manager_phone" type="text" defaultValue={pharmacy?.manager_phone} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="manager-mobile" className="text-xs font-black text-slate-500 mr-2">الموبايل</label>
                <input id="manager-mobile" name="manager_mobile" type="text" defaultValue={pharmacy?.manager_mobile} className="w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 p-3 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between bg-slate-50 dark:bg-slate-900 p-4 sm:p-5 rounded-xl border border-slate-200 dark:border-slate-800">
        <p className="text-slate-500 text-sm font-medium">* يرجى التأكد من صحة البيانات المدخلة لأغراض الفواتير والتقارير القانونية.</p>
        <button 
          disabled={loading}
          className="min-h-11 bg-blue-700 text-white px-5 py-2.5 rounded-lg font-semibold shadow-sm hover:bg-blue-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading ? 'جاري الحفظ...' : 'حفظ البيانات'}
          {!loading && <Save className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}
