import { CreatePatientSchema, PatientSchema } from '@/lib/db/schema';

describe('global patient master schema', () => {
  const patient = {
    id: '11111111-1111-4111-8111-111111111111',
    full_name: 'Global Patient',
    credit_limit: 0,
    points_balance: -25,
    customer_type: 'individual',
    created_at: '2026-09-30T08:00:00.000Z',
  };

  it('matches the deployed patient table without a pharmacy_id field', () => {
    expect(PatientSchema.parse(patient)).toEqual(patient);
  });

  it('does not require branch scope when creating a patient master record', () => {
    const { id: _id, created_at: _createdAt, ...createPatient } = patient;
    expect(CreatePatientSchema.parse(createPatient)).toEqual(createPatient);
  });
});
