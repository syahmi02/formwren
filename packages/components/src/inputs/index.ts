import { registerComponent, type Registry } from '../contract.ts';
import { inputMetas } from '../meta/inputs.ts';
import { Button } from './Button.tsx';
import { Checkbox } from './Checkbox.tsx';
import { ComboBox } from './ComboBox.tsx';
import { DatePicker } from './DatePicker.tsx';
import { Label } from './Label.tsx';
import { NumberInput } from './NumberInput.tsx';
import { RadioGroup } from './RadioGroup.tsx';
import { TextArea } from './TextArea.tsx';
import { TextInput } from './TextInput.tsx';

export const inputComponents: Registry = {
  Label: registerComponent(inputMetas.Label!, Label),
  Button: registerComponent(inputMetas.Button!, Button),
  TextInput: registerComponent(inputMetas.TextInput!, TextInput),
  TextArea: registerComponent(inputMetas.TextArea!, TextArea),
  NumberInput: registerComponent(inputMetas.NumberInput!, NumberInput),
  Checkbox: registerComponent(inputMetas.Checkbox!, Checkbox),
  RadioGroup: registerComponent(inputMetas.RadioGroup!, RadioGroup),
  ComboBox: registerComponent(inputMetas.ComboBox!, ComboBox),
  DatePicker: registerComponent(inputMetas.DatePicker!, DatePicker),
};
