"""SMTP bridge. Credentials remain in an explicitly named environment variable."""
import hashlib
import json
import os
import re
import smtplib
import ssl
import sys
from email.message import EmailMessage


def mailbox(value):
    return (isinstance(value, str) and 6 <= len(value) <= 254
            and re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+", value)
            and not value.startswith('.') and '..' not in value
            and len(value.split('@')[0]) <= 64 and not value.split('@')[0].endswith('.'))


def main():
    data = json.loads(sys.stdin.read())
    if not mailbox(data.get('recipient')):
        raise ValueError('recipient invalid')
    sender = data.get('from', '')
    if not mailbox(sender):
        raise ValueError('sender invalid')
    if data.get('port') not in (465, 587):
        raise ValueError('TLS SMTP ports only')
    password = os.environ.get(data.get('passwordEnv', ''))
    if not password:
        raise ValueError('password environment missing')
    msg = EmailMessage()
    msg['From'] = sender
    msg['To'] = data['recipient']
    msg['Subject'] = data['subject']
    digest = hashlib.sha256(data['id'].encode()).hexdigest()
    message_id = '<%s@%s>' % (digest, sender.split('@')[1])
    msg['Message-ID'] = message_id
    msg.set_content(data['text'])
    msg.add_alternative(data['html'], subtype='html')
    context = ssl.create_default_context()
    smtp = None
    try:
        if data['port'] == 465:
            smtp = smtplib.SMTP_SSL(data['host'], 465, timeout=15, context=context)
        else:
            smtp = smtplib.SMTP(data['host'], 587, timeout=15)
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(data.get('username') or sender, password)
        refused = smtp.send_message(msg)
        result = {'state': 'failed' if refused else 'submitted', 'messageId': message_id,
                  'note': 'SMTP accepted is not proof of inbox arrival or reading'}
    except smtplib.SMTPAuthenticationError:
        result = {'state': 'failed', 'code': 'AUTH_REQUIRED'}
    except smtplib.SMTPRecipientsRefused:
        result = {'state': 'failed', 'code': 'RECIPIENT_REFUSED'}
    except Exception:
        result = {'state': 'uncertain', 'code': 'SMTP_OUTCOME_UNKNOWN'}
    finally:
        if smtp:
            try:
                smtp.quit()
            except Exception:
                pass
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'state': 'failed', 'code': 'CONFIG_INVALID'}))
