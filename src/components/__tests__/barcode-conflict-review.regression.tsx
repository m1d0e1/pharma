import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import BarcodeConflictReviewModal from '../inventory/BarcodeConflictReviewModal';
import { correctDrugBarcodeConflictAction, findDrugBarcodeOwners, getDuplicateDrugBarcodeGroupsAction } from '@/app/actions-client/drug-replacement';

jest.mock('@/app/actions-client/drug-replacement', () => ({
  correctDrugBarcodeConflictAction: jest.fn(),
  findDrugBarcodeOwners: jest.fn(),
  getDuplicateDrugBarcodeGroupsAction: jest.fn(),
}));
jest.mock('../master-drugs/DrugReplacementDialog', () => function MockDrugReplacementDialog(props: any) {
  return <div role="dialog" aria-label="replacement-probe">
    <span>source-{props.source.id}</span>
    <span>target-{props.target.id}</span>
    <button onClick={() => props.onClose()}>close-replacement</button>
  </div>;
});

it('lists every duplicate barcode group and opens all-owner reconciliation for a three-owner conflict', async () => {
  (getDuplicateDrugBarcodeGroupsAction as jest.Mock).mockResolvedValue([
    { barcode: '123', owner_count: 3, owner_ids: [10,20,30], owner_names: ['Canonical','Custom','Third'] },
    { barcode: '999', owner_count: 2, owner_ids: [40,50], owner_names: ['Different strength A','Different strength B'] },
  ]);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([
    { id: 10, trade_name: 'Canonical', barcode: '123' },
    { id: 20, trade_name: 'Custom', barcode: '123' },
    { id: 30, trade_name: 'Third', barcode: '123' },
  ]);

  render(<BarcodeConflictReviewModal onClose={jest.fn()} onEditDrug={jest.fn()} />);

  await waitFor(() => expect(screen.getByText(/تعارضات الباركود/)).toHaveTextContent('2'));
  expect(screen.getByText(/Different strength A/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'مراجعة التعارض' })[0]);

  expect(await screen.findByText(/كل الأصناف المرتبطة بهذا الباركود/)).toBeInTheDocument();
  expect(screen.getAllByText(/Third/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'فتح الدمج الجماعي' }));
  expect(await screen.findByRole('dialog', { name: 'replacement-probe' })).toHaveTextContent('source-10');
  expect(screen.getByRole('dialog', { name: 'replacement-probe' })).toHaveTextContent('target-20');
});

it('forces a merge direction for two owners and safely corrects an active barcode when they are different products', async () => {
  const first = { id: 40, trade_name: 'LAMIFEN 125 MG', barcode: '999' };
  const second = { id: 50, trade_name: 'LAMIFEN 250 MG', barcode: '999' };
  (getDuplicateDrugBarcodeGroupsAction as jest.Mock).mockResolvedValue([
    { barcode: '999', owner_count: 2, owner_ids: [40,50], owner_names: [first.trade_name,second.trade_name] },
  ]);
  (findDrugBarcodeOwners as jest.Mock).mockResolvedValue([first, second]);
  (correctDrugBarcodeConflictAction as jest.Mock).mockResolvedValue({ success: true, id: 40, backupPath: 'barcode-backup.db' });
  const onResolved = jest.fn();

  render(<BarcodeConflictReviewModal onClose={jest.fn()} onEditDrug={jest.fn()} onResolved={onResolved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'مراجعة التعارض' }));

  expect(await screen.findByText(/اختر السجل النهائي/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'تصحيح باركود #40' }));
  const barcodeInput = await screen.findByLabelText('الباركود الصحيح للصنف #40');
  expect(barcodeInput).toHaveValue('');
  fireEvent.change(barcodeInput, { target: { value: '888' } });
  fireEvent.change(screen.getByLabelText('كلمة مرور المدير لتصحيح الباركود'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByLabelText(/أؤكد أن الباركود الحالي 999 خاطئ/));
  fireEvent.click(screen.getByRole('button', { name: 'تطبيق تصحيح الباركود' }));
  await waitFor(() => expect(correctDrugBarcodeConflictAction).toHaveBeenCalledWith(40, '999', '888', 'pw'));
  await waitFor(() => expect(onResolved).toHaveBeenCalled());

  fireEvent.click(await screen.findByRole('button', { name: 'مراجعة التعارض' }));
  await screen.findByText(/اختر السجل النهائي/);
  fireEvent.click(screen.getByRole('button', { name: 'الاحتفاظ بالصنف #50' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'replacement-probe' })).toHaveTextContent('source-40'));
  expect(screen.getByRole('dialog', { name: 'replacement-probe' })).toHaveTextContent('target-50');
});
