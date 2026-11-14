import { parseDate, type CalendarDate } from '@internationalized/date';
import { useRef } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  FieldError,
  Group,
  Heading,
  I18nProvider,
  Label,
  Popover,
} from 'react-aria-components';
import type { HostProps } from '../contract.ts';
import { fallbackName, toText, useDraft, useFocusHandle } from './shared.ts';

export interface DatePickerProps {
  label?: string;
  value?: string | null;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  errorMessage?: string;
}

/** 'YYYY-MM-DD' to a date. Anything else is no date. */
function toDate(text: string | null | undefined): CalendarDate | null {
  if (!text) return null;
  try {
    return parseDate(text);
  } catch {
    return null;
  }
}

/** Some date segments are filled and some are empty. */
function isPartial(root: HTMLElement | null): boolean {
  if (!root) return false;
  const segments = root.querySelectorAll('[role="spinbutton"]');
  const empty = root.querySelectorAll('[role="spinbutton"][data-placeholder="true"]').length;
  return segments.length > 0 && empty > 0 && empty < segments.length;
}

export function DatePicker({ props, id, write, accepts, fire, handleRef, design }: HostProps<DatePickerProps>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const open = useRef(false);
  useFocusHandle(handleRef, () => groupRef.current?.querySelector<HTMLElement>('[role="spinbutton"]')?.focus());
  const draft = useDraft({
    value: props.value,
    boundRow: props.boundRow,
    boundRevision: props.boundRevision,
    boundType: props.boundType,
    write,
    accepts,
    fire,
    design,
    readOnly: props.readOnly,
    disabled: props.disabled,
    checkFit: true,
    check: (text) => {
      // ISO dates compare correctly as text.
      if (text !== '' && props.min && text < props.min) return `Must be on or after ${props.min}`;
      if (text !== '' && props.max && text > props.max) return `Must be on or before ${props.max}`;
      return null;
    },
    toWrite: (text) => (text === '' ? null : text),
    commitOnEnter: true,
  });
  const message = props.errorMessage || draft.message;
  const checkPartial = (): boolean => {
    if (!isPartial(groupRef.current)) return false;
    draft.markInvalid('Enter a complete date');
    return true;
  };
  return (
    <I18nProvider locale="en-US">
      <AriaDatePicker
        // A new row or a discarded draft starts the segments afresh, so a partial date can't carry over.
        key={`${props.boundRow ?? 'none'}:${draft.restores}`}
        className="fw-datepicker"
        aria-label={fallbackName(props, id)}
        data-required={props.required || undefined}
        value={toDate(toText(draft.text))}
        minValue={toDate(props.min)}
        maxValue={toDate(props.max)}
        onChange={(date) => {
          if (design || props.readOnly) return;
          const text = date ? date.toString() : '';
          // A date picked in the calendar is a choice, so it writes at once. Typed segments wait for blur.
          if (open.current) draft.commitText(text);
          else draft.handlers.onChange(text);
        }}
        onOpenChange={(isOpen) => {
          open.current = isOpen;
        }}
        onFocus={draft.handlers.onFocus}
        onBlur={() => {
          if (open.current) return;
          checkPartial();
          draft.handlers.onBlur();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !open.current && checkPartial()) return;
          draft.handlers.onKeyDown(e as never);
        }}
        isDisabled={props.disabled}
        isReadOnly={props.readOnly}
        isRequired={props.required}
        isInvalid={message !== undefined}
        validationBehavior="aria"
        granularity="day"
      >
        {props.label ? <Label className="fw-datepicker__label">{props.label}</Label> : null}
        <Group ref={groupRef} className="fw-datepicker__group">
          <DateInput className="fw-datepicker__input">
            {(segment) => <DateSegment segment={segment} className="fw-datepicker__segment" />}
          </DateInput>
          <Button className="fw-datepicker__button" aria-label="Open calendar">
            <span aria-hidden="true">{'▾'}</span>
          </Button>
        </Group>
        {message ? (
          <FieldError className="fw-datepicker__error">
<span title={message}>{message}</span>
</FieldError>
        ) : null}
        <Popover className="fw-datepicker__popover">
          <Dialog className="fw-datepicker__dialog">
            <Calendar className="fw-datepicker__calendar">
              <header className="fw-datepicker__calendar-header">
                <Button slot="previous" className="fw-datepicker__calendar-nav" aria-label="Previous month">
                  {'‹'}
                </Button>
                <Heading className="fw-datepicker__calendar-title" />
                <Button slot="next" className="fw-datepicker__calendar-nav" aria-label="Next month">
                  {'›'}
                </Button>
              </header>
              <CalendarGrid className="fw-datepicker__calendar-grid">
                {(date) => <CalendarCell date={date} className="fw-datepicker__calendar-cell" />}
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </AriaDatePicker>
    </I18nProvider>
  );
}
