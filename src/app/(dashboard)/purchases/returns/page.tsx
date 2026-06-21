'use client';

import React from 'react';
import ReturnsClient from '@/components/returns/ReturnsClient';

export default function ReturnsPage() {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-700">
      <ReturnsClient title="مرتجعات المشتريات" type="purchases" />
    </div>
  );
}
