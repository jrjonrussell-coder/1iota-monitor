#!/usr/bin/env python3
"""Send one alert over Gmail SMTP using only the standard library.

Credentials and recipient arrive as environment variables sourced from
repository secrets. Nothing sensitive is written to disk or to the log.
"""
import os
import smtplib
import sys
from email.message import EmailMessage

user = os.environ["MAIL_USERNAME"]
password = os.environ["MAIL_PASSWORD"]
to = os.environ["MAIL_TO"]
subject = os.environ.get("SUBJECT", "1iota monitor")

body = os.environ.get("BODY")
if body is None:
    try:
        with open("summary.txt", encoding="utf-8") as fh:
            body = fh.read()
    except OSError:
        body = "No summary was produced by this sweep."

msg = EmailMessage()
msg["From"] = user
msg["To"] = to
msg["Subject"] = subject
msg.set_content(body)

try:
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)
except Exception as exc:
    # Never echo the exception verbatim; SMTP errors can quote credentials.
    print(f"Mail send failed: {type(exc).__name__}", file=sys.stderr)
    raise SystemExit(1)

print("Alert sent.")
