import React from 'react';
import { render, screen } from '@testing-library/react';
import { Input } from './input';

describe('Input Component accessibility', () => {
  it('uses a stable generated id to associate the label', () => {
    const { rerender } = render(<Input label="اسم العميل" />);
    const input = screen.getByLabelText('اسم العميل');
    const firstId = input.id;

    rerender(<Input label="اسم العميل" />);
    expect(screen.getByLabelText('اسم العميل')).toHaveAttribute('id', firstId);
  });

  it('connects validation and helper copy to the field', () => {
    render(<Input label="الهاتف" error="رقم الهاتف غير صالح" />);
    const input = screen.getByLabelText('الهاتف');
    const message = screen.getByText('رقم الهاتف غير صالح');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', message.id);
  });
});
