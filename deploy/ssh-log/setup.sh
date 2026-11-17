#!/bin/bash
# Gives Nuvytrix its own copy of the SSH daemon's log lines, so the API container no longer needs
# the whole /var/log mounted (docs/INFRASTRUCTURE_CAPABILITY_AUDIT.md, finding 7). Run once with sudo on the server:
#
#   sudo bash ~/nuvytrix/nuvytrix-backend/deploy/ssh-log/setup.sh
#
# What it changes: one rsyslog rule (sshd lines are also written to /var/log/nuvytrix/sshd.log;
# auth.log is unchanged), one logrotate entry, and a rsyslog restart. Undo:
#   sudo rm /etc/rsyslog.d/30-nuvytrix-sshd.conf /etc/logrotate.d/nuvytrix-sshd && sudo systemctl restart rsyslog
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo" >&2; exit 1; }

install -d -o syslog -g adm -m 0750 /var/log/nuvytrix
[ -f /var/log/nuvytrix/sshd.log ] || install -o syslog -g adm -m 0640 /dev/null /var/log/nuvytrix/sshd.log

cat > /etc/rsyslog.d/30-nuvytrix-sshd.conf <<'CONF'
# Nuvytrix SSH monitoring: a copy of sshd's auth lines, readable by group adm only.
if ($programname == 'sshd' or $programname == 'sshd-session') and ($syslogfacility-text == 'auth' or $syslogfacility-text == 'authpriv') then {
  action(type="omfile" file="/var/log/nuvytrix/sshd.log" template="RSYSLOG_FileFormat"
         fileOwner="syslog" fileGroup="adm" fileCreateMode="0640")
}
CONF

cat > /etc/logrotate.d/nuvytrix-sshd <<'CONF'
/var/log/nuvytrix/sshd.log {
	weekly
	rotate 4
	missingok
	notifempty
	compress
	delaycompress
	create 0640 syslog adm
	postrotate
		/usr/lib/rsyslog/rsyslog-rotate
	endscript
}
CONF

rsyslogd -N1 >/dev/null
systemctl restart rsyslog
echo "ok: sshd lines now also go to /var/log/nuvytrix/sshd.log"
