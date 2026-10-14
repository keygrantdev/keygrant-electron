/**
 * What a text shown on one line may not hold: a C0 or C1 control, DEL, or a
 * line or paragraph separator. Not exported from the package: the licence
 * file's signer and its note writer are its users.
 */
const CONTROL_CLASS = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]'

/** Whether a text holds any such character. */
export const CONTROL = new RegExp(CONTROL_CLASS)

/** Every such character, to replace. */
export const CONTROLS = new RegExp(CONTROL_CLASS, 'g')
