import { fireEvent, render, screen } from '@testing-library/react';
import ManufacturersPage from '@/app/(dashboard)/stores/manufacturers/page';
import NaturePage from '@/app/(dashboard)/stores/nature/page';
import UnitsPage from '@/app/(dashboard)/stores/units/page';
import UsagePage from '@/app/(dashboard)/stores/usage/page';
import ScientificGroupsPage from '@/app/(dashboard)/stores/scientific-groups/page';
import IndicationsPage from '@/app/(dashboard)/stores/indications/page';
import AdjustmentReasonsPage from '@/app/(dashboard)/stores/adjustment-reasons/page';
import { getClientSession } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';

const push = jest.fn();
const mockRouter = { push };

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({ dbSelect: jest.fn() }));
jest.mock('@/app/actions-client/master-drugs', () => ({
  addManufacturerAction: jest.fn(), updateGenericBilingualAction: jest.fn(), deleteGenericBilingualAction: jest.fn(),
  addItemNatureAction: jest.fn(), updateItemNatureAction: jest.fn(), deleteItemNatureAction: jest.fn(),
  addUnitAction: jest.fn(), updateUnitAction: jest.fn(), deleteUnitAction: jest.fn(),
  addUsageMethodAction: jest.fn(), updateUsageMethodAction: jest.fn(), deleteUsageMethodAction: jest.fn(),
  addScientificGroupAction: jest.fn(), updateScientificGroupAction: jest.fn(), deleteScientificGroupAction: jest.fn(),
  addIndicationAction: jest.fn(), updateIndicationAction: jest.fn(), deleteIndicationAction: jest.fn(),
  addAdjustmentReasonAction: jest.fn(), updateAdjustmentReasonAction: jest.fn(), deleteAdjustmentReasonAction: jest.fn(),
}));
jest.mock('@/components/inventory/BilingualManagementClient', () => function MockBilingualManagementClient({ title, initialData }: any) {
  return <div>master-data:{title}:{initialData.map((item: any) => item.id).join(',')}</div>;
});

const owner = { id: 'owner-1', role: 'owner' };

beforeEach(() => {
  jest.clearAllMocks();
  (getClientSession as jest.Mock).mockResolvedValue(owner);
});

const routes: Array<[string, React.ComponentType, string]> = [
  ['manufacturers', ManufacturersPage, 'الشركات المنتجة'],
  ['nature', NaturePage, 'طبيعة صنف'],
  ['units', UnitsPage, 'وحدة قياس'],
  ['usage', UsagePage, 'طريقة إستخدام'],
  ['scientific groups', ScientificGroupsPage, 'مجموعة علمية'],
  ['indications', IndicationsPage, 'داعي إستخدام'],
  ['adjustment reasons', AdjustmentReasonsPage, 'سبب تسوية'],
];

it.each(routes)('distinguishes a failed %s route load from a legitimate empty master-data list and retries', async (_name, Page, title) => {
  (dbSelect as jest.Mock)
    .mockRejectedValueOnce(new Error('db unavailable'))
    .mockResolvedValueOnce([{ id: 'recovered-1', name_ar: 'مستعاد' }]);

  render(<Page />);

  expect(await screen.findByText('تعذر تحميل بيانات القائمة')).toBeInTheDocument();
  expect(screen.queryByText(`master-data:${title}:`)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText(`master-data:${title}:recovered-1`)).toBeInTheDocument();
});

it('recovers an authenticated master-data wrapper when the local session bridge throws', async () => {
  (getClientSession as jest.Mock)
    .mockRejectedValueOnce(new Error('session unavailable'))
    .mockResolvedValueOnce(owner);
  (dbSelect as jest.Mock).mockResolvedValue([{ id: 'unit-recovered', name_ar: 'وحدة مستعادة' }]);

  render(<UnitsPage />);

  expect(await screen.findByText('تعذر تحميل بيانات القائمة')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  expect(await screen.findByText('master-data:وحدة قياس:unit-recovered')).toBeInTheDocument();
});
