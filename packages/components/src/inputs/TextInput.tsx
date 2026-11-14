import type { HostProps } from '../contract.ts';
import { TextFieldBase, type TextProps } from './TextField.tsx';

export function TextInput(host: HostProps<TextProps>) {
  return <TextFieldBase type="textinput" multiline={false} host={host} />;
}
