import type { HostProps } from '../contract.ts';
import { TextFieldBase, type TextProps } from './TextField.tsx';

export function TextArea(host: HostProps<TextProps>) {
  return <TextFieldBase type="textarea" multiline host={host} />;
}
