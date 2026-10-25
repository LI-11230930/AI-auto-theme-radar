"""Offline SMTP bridge contract tests. No sockets or real credentials are used."""
import importlib.util
import io
import json
from pathlib import Path
import smtplib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('radar_smtp_bridge', Path(__file__).resolve().parents[1] / 'bridges/smtp_send.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeSmtp:
    def __init__(self):
        self.message = None
    def login(self, username, password):
        assert username == 'sender@example.org' and password == 'fixture-only'
    def send_message(self, message):
        self.message = message
        return {}
    def quit(self):
        pass


class BridgeTests(unittest.TestCase):
    def data(self):
        return {'id': 'fixture', 'from': 'sender@example.org', 'recipient': 'reader@example.org', 'host': 'smtp.invalid', 'port': 465, 'passwordEnv': 'RADAR_TEST_SMTP_PASSWORD', 'subject': 'Offline fixture', 'text': 'fixture', 'html': '<p>fixture</p>'}

    def invoke(self, data, smtp):
        out = io.StringIO()
        with patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(data))), patch.object(bridge.sys, 'stdout', out), patch.dict(bridge.os.environ, {'RADAR_TEST_SMTP_PASSWORD': 'fixture-only'}), patch.object(bridge.smtplib, 'SMTP_SSL', return_value=smtp) as constructor:
            bridge.main()
        return json.loads(out.getvalue()), constructor

    def test_explicit_installer_address_reaches_only_stub(self):
        smtp = FakeSmtp()
        result, constructor = self.invoke(self.data(), smtp)
        self.assertEqual(result['state'], 'submitted')
        self.assertEqual(smtp.message['To'], 'reader@example.org')
        self.assertEqual(smtp.message['From'], 'sender@example.org')
        self.assertEqual(constructor.call_count, 1)

    def test_header_injection_and_multi_recipient_rejected_before_socket(self):
        for receiver in ['a@example.org\r\nBcc:b@example.org', 'a@example.org,b@example.org', 'Name <a@example.org>', 'a..b@example.org', 'a@-example.org']:
            data = self.data()
            data['recipient'] = receiver
            with self.subTest(receiver=receiver), patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(data))), patch.object(bridge.smtplib, 'SMTP_SSL') as constructor:
                with self.assertRaises(ValueError):
                    bridge.main()
                constructor.assert_not_called()

    def test_invalid_sender_and_port_rejected_before_socket(self):
        for change in [{'from': 'x@example.org,b@example.org'}, {'port': 25}]:
            data = dict(self.data(), **change)
            with patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(data))), patch.object(bridge.smtplib, 'SMTP_SSL') as constructor:
                with self.assertRaises(ValueError):
                    bridge.main()
                constructor.assert_not_called()

    def test_recipient_refusal_is_failed(self):
        smtp = FakeSmtp()
        smtp.send_message = lambda message: {'reader@example.org': (550, b'fixture refusal')}
        self.assertEqual(self.invoke(self.data(), smtp)[0]['state'], 'failed')

    def test_authentication_failure_does_not_echo_provider_text(self):
        smtp = FakeSmtp()
        def fail(*args):
            raise smtplib.SMTPAuthenticationError(535, b'fixture-private-provider-text')
        smtp.login = fail
        result, _ = self.invoke(self.data(), smtp)
        self.assertEqual(result, {'state': 'failed', 'code': 'AUTH_REQUIRED'})

    def test_unknown_transport_result_remains_uncertain(self):
        smtp = FakeSmtp()
        def fail(message):
            raise TimeoutError('fixture-after-send')
        smtp.send_message = fail
        self.assertEqual(self.invoke(self.data(), smtp)[0], {'state': 'uncertain', 'code': 'SMTP_OUTCOME_UNKNOWN'})


if __name__ == '__main__':
    unittest.main()
