/** A single plain mailbox, suitable for configuration and delivery identity keys. */
export function isEmailAddress(value:unknown):value is string{
 return typeof value==='string'&&value.length<=254&&value.length>=6&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)&&!value.startsWith('.')&&!value.includes('..')&&value.split('@')[0].length<=64&&!value.split('@')[0].endsWith('.');
}
