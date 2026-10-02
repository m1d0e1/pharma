import React from 'react';
import { render, screen } from '@testing-library/react';
import { Textarea } from './textarea';

describe('Textarea Component accessibility', () => {
  it('uses a stable generated id to associate the label', () => {
    const { rerender } = render(<Textarea label="ملاحظات" />);
    const textarea = screen.getByLabelText('ملاحظات');
    const firstId = textarea.id;

    rerender(<Textarea label="ملاحظات" />);
    expect(screen.getByLabelText('ملاحظات')).toHaveAttribute('id', firstId);
  });

  it('connects validation and helper copy to the field', () => {
    render(<Textarea label="ملاحظات" error="الملاحظات غير صالحة" />);
    const textarea = screen.getByLabelText('ملاحظات');
    const message = screen.getByText('الملاحظات غير صالحة');

    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAttribute('aria-describedby', message.id);
  });
});
