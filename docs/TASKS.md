# Nuvytrix – taskovi

Redosled je redosled rada. „Zavisi od“ kaže šta mora biti gotovo pre taska.
Status: ⬜ nije počet · 🟨 u radu · ✅ gotovo · ⛔ čeka odobrenje

---

## Faza 1 – Audit

### NVX-01 – Audit postojeće infrastrukture i plan ✅
**Opis:** Pregledati backend, frontend, bazu i migracije, Docker Compose, integraciju sa ruterom, monitoring, obaveštenja, nmap, audit log, `backup.sh`/`backup.log` i stanje servera (RAM, CPU, disk, port 53, `systemd-resolved`). Napraviti `docs/INFRASTRUCTURE_CAPABILITY_AUDIT.md` sa statusima IMPLEMENTED / PARTIALLY_IMPLEMENTED / MISSING / HARDWARE_LIMITED / EXTERNAL_SERVICE_REQUIRED.
**Prihvatanje:** dokument postoji; za svaku stavku piše gde je u kodu ili zašto ne može; procena resursa i spisak rizika; ništa promenjeno na serveru ni ruteru.
**Rizik:** nema (samo čitanje).

---

## Faza 2 – Inteligencija uređaja

### NVX-02 – Istorija identiteta uređaja (IP/MAC/hostname) ✅
**Opis:** Pamtiti svaku promenu IP adrese, hostname-a i proizvođača po uređaju. Otkriti kad ista IP adresa dobije novi MAC (zamena uređaja ili spoofing) i kad dva MAC-a koriste istu IP (IP konflikt). Izvori: nmap skeniranje i spisak uređaja sa rutera.
**Prihvatanje:** detalj uređaja prikazuje istoriju promena; obaveštenje za neočekivanu promenu MAC-a i IP konflikt; testovi.
**Zavisi od:** NVX-01

### NVX-03 – DHCP dodele i način dodele ✅
**Opis:** Iz podataka rutera čuvati način dodele (DHCP ili statička) i preostalo vreme dodele; prikazati kad dodela ističe; povezati rezervacije sa rutera sa uređajem.
**Prihvatanje:** lista i detalj uređaja prikazuju DHCP/static, istek dodele i oznaku rezervacije.
**Zavisi od:** NVX-01

### NVX-04 – Istorija dostupnosti uređaja ✅
**Opis:** Pamtiti online/offline stanje po uređaju iz čitanja rutera (na 5 min) i nmap skeniranja. Traka dostupnosti po uređaju za 24 h i 7 dana. Opciono obaveštenje kad označeni uređaj (npr. NAS) nestane.
**Prihvatanje:** grafikon dostupnosti po uređaju; rezolucija (~5 min) jasno napisana u UI-ju.
**Zavisi od:** NVX-02

### NVX-05 – Upravljanje uređajima: oznake, beleške, poverenje ✅
**Opis:** Oznake (tags), kategorija/tip, beleške i status poverenja (trusted/untrusted), uz pretragu i filtere. Proširiti postojeće ime i tip, bez novih ekrana.
**Prihvatanje:** sve se čuva, filtrira i upisuje u audit; nepoznat uređaj (bez imena i neodobren) jasno označen.
**Zavisi od:** NVX-01

---

## Faza 3 – Napredni monitoring mreže

### NVX-06 – Jitter, vreme odgovora DNS-a i istorija prekida ✅
**Opis:** Čuvati jitter (mdev iz ping-a) i vreme odgovora DNS ciljeva. Iz rezultata provera izvesti listu prekida (početak, kraj, trajanje). Grafikoni sa jasnom oznakom izvora (merenje sa servera, brojači rutera, spoljni test).
**Prihvatanje:** grafikon jittera i DNS vremena; lista prekida za internet, ruter i ostale ciljeve.
**Zavisi od:** NVX-01

### NVX-07 – HTTP/HTTPS ciljevi monitoringa ✅
**Opis:** Novi tip cilja HTTP(S): status kod, vreme odgovora, istek sertifikata. Koristiti za 6 sajtova i Nuvytrix.
**Prihvatanje:** svih 6 sajtova se prati; obaveštenje kad sajt padne i kad sertifikat ističe za manje od 14 dana.
**Zavisi od:** NVX-06

---

## Faza 4 – Server

### NVX-08 – Monitoring Ubuntu servera ✅
**Opis:** CPU, RAM, disk, load, uptime, temperatura, greške mrežnog interfejsa i stanje baterije/napajanja (server je laptop). Čitanje iz read-only `/proc` i `/sys`, bez root-a. Ekran Server sa istorijom.
**Prihvatanje:** vrednosti se poklapaju sa `top`/`df`/`free`; istorija 7 dana; obaveštenje kad server pređe na bateriju.
**Zavisi od:** NVX-01

### NVX-09 – Monitoring PostgreSQL-a ✅
**Opis:** Dostupnost, broj konekcija, veličina baze, najduži aktivan upit, iz postojeće konekcije aplikacije.
**Prihvatanje:** prikaz u ekranu Server; obaveštenje kad baza nije dostupna.
**Zavisi od:** NVX-08

---

## Faza 5 – Docker

### NVX-10 – Read-only Docker proxy ✅
**Opis:** docker-socket-proxy sa dozvoljenim samo `GET` za containers i info; bez exec, create, delete i restart; nije izložen van Docker mreže; konfiguracija dokumentovana.
**Prihvatanje:** Nuvytrix vidi kontejnere; `POST` na proxy vraća 403 (provereno); sajtovi rade bez prekida.
**Rizik:** nizak (izmena `docker-compose`).
**Zavisi od:** NVX-01

### NVX-11 – Monitoring kontejnera ✅
**Opis:** Po kontejneru: stanje, health, broj restarta, poslednji restart, uptime, CPU, RAM. Obaveštenje kad kontejner padne ili se restartuje.
**Prihvatanje:** svih 6 sajtova i Nuvytrix vidljivi; probni restart test-kontejnera daje obaveštenje.
**Zavisi od:** NVX-10

---

## Faza 6 – Bezbednost mreže

### NVX-12 – Nmap skeniranje portova i servisa ✅
**Opis:** Ručno i zakazano skeniranje portova sa prepoznavanjem servisa i verzija, samo 192.168.100.0/24. Istorija po uređaju i poređenje sa prethodnim: nov port, zatvoren port, promena verzije. Bez agresivnih skripti.
**Prihvatanje:** detalj uređaja prikazuje portove i istoriju; obaveštenje za nov otvoren port; skeniranje ne ometa mrežu (izmereno).
**Zavisi od:** NVX-02

### NVX-13 – Praćenje SSH prijava ✅
**Opis:** Čitanje `auth.log` hosta preko read-only mount-a. Uspešne i neuspele prijave, izvorne IP adrese, nova IP adresa, ponovljeni neuspesi. Bez promene SSH konfiguracije.
**Prihvatanje:** ekran SSH sa istorijom; probna neuspela prijava vidljiva; obaveštenje za novu IP adresu i više neuspeha.
**Zavisi od:** NVX-01

---

## Faza 7 – AdGuard Home

### NVX-14 – Deploy AdGuard Home ✅
**Opis:** Proveriti port 53 i `systemd-resolved`. AdGuard u Docker-u, vezan samo za 192.168.100.27 i Tailscale adresu, trajni podaci, health check, automatski restart. Admin interfejs samo sa LAN-a i Tailscale-a.
**Prihvatanje:** `dig @192.168.100.27` radi; sajtovi i Nuvytrix rade; port 53 nije otvoren ka internetu.
**Rizik:** srednji (port 53 na serveru).
**Zavisi od:** NVX-01

### NVX-15 – Integracija AdGuard-a u Nuvytrix ✅
**Opis:** Upiti, blokirani zahtevi, top domeni i top blokirani, statistika po klijentu povezana sa uređajima, allowlist, blocklist, sopstvena pravila, stanje upstream servera i vreme odgovora.
**Prihvatanje:** vrednosti se poklapaju sa AdGuard UI-jem; izmene lista rade i upisuju se u audit.
**Zavisi od:** NVX-14

### NVX-16 – Test na jednom uređaju i zaštita od kvara 🟨
_Stanje 2026-11-16: upiti sa PC-ja rade, blokiranje radi, oporavak posle restarta i obaveštenje „DNS ne radi“ provereni, uputstvo u docs/adguard.md. Ostaje: jedan uređaj da koristi AdGuard ceo dan._
**Opis:** Na jednom uređaju (npr. PC) ručno postaviti DNS na AdGuard; proveriti filtriranje i oporavak posle restarta kontejnera; obaveštenje „DNS ne radi“; uputstvo za povratak na stari DNS.
**Prihvatanje:** uređaj radi kroz AdGuard bar jedan dan; obaveštenje radi; povratak opisan.
**Zavisi od:** NVX-15

### NVX-17 – Predlog DNS-a za celu kuću (bez izmene) ✅
**Opis:** Istražiti zašto je ranija promena DHCP DNS-a na ruteru istekla, IPv6 DNS (ruter deli `fe80::1` preko DHCPv6, pa uređaji mogu da zaobiđu AdGuard), DoH/DoT, Android Private DNS, secure DNS u browserima i VPN-ove. Predlog sa tačnim koracima, povratkom i rizicima.
**Prihvatanje:** dokument postoji; na ruteru ništa nije promenjeno.
**Zavisi od:** NVX-16

### NVX-18 – Promena DNS-a za celu kuću ⛔
_2026-11-17: nije urađeno. Ruter čuva DNS samo zajedno sa celim DHCP-om (uključujući L2 relay i option 125); tačan zahtev je zapisan u docs/adguard.md. Čeka: jednodnevnu probu (NVX-16), pa test sa ruterom kao DNS-om, pa prelazak._
**Opis:** Samo uz izričito odobrenje. Promeniti DNS u DHCP-u rutera na 192.168.100.27 (i IPv6 DNS po odluci), uz čitanje sa rutera posle promene, test na uređajima i spreman povratak.
**Prihvatanje:** ruter stvarno prikazuje novi DNS; uređaji idu kroz AdGuard; povratak testiran.
**Rizik:** visok (DNS cele kuće).
**Zavisi od:** NVX-17 + odobrenje

---

## Faza 8 – Obaveštenja i pouzdanost

### NVX-19 – Podesiva obaveštenja ✅
**Opis:** Proširiti postojeća obaveštenja pragovima: CPU, RAM, disk, latencija, jitter, gubitak paketa, dostupnost uređaja, internet, DNS, kontejneri, SSH, novi portovi, backup. Nivoi ozbiljnosti, potvrda (acknowledge), „rešeno“, bez duplikata. Bez generičkog rule engine-a.
**Prihvatanje:** pragovi se menjaju u UI-ju; isto obaveštenje se ne ponavlja dok se stanje ne promeni.
**Zavisi od:** NVX-08, NVX-11, NVX-13

### NVX-20 – Stanje backup-a ✅
**Opis:** Prikazati backup-e iz `/mnt/data/backups` i `backup.log` fajlova (Nuvytrix i sajtovi): poslednji uspešan i neuspešan, postojanje i veličina fajla, retencija, provera ispravnosti. Ne praviti drugi backup sistem. Napomena: homewise i portfolio trenutno nemaju backup.
**Prihvatanje:** ekran prikazuje stvarne fajlove; obaveštenje kad backup ne uspe ili kasni.
**Zavisi od:** NVX-01

### NVX-21 – Stanje integracija ✅
**Opis:** Jedan ekran: ruter, otkrivanje uređaja, DNS, AdGuard, Docker, PostgreSQL, SSH, backup, Tailscale. Za svaku: poslednja uspešna provera, trenutno stanje, poslednja greška.
**Prihvatanje:** svaka integracija ima stvarnu proveru; greška u jednoj se vidi i ne obara ostale.
**Zavisi od:** NVX-11, NVX-15, NVX-20

---

## Faza 9 – Opciono i završno

### NVX-22 – Procena CrowdSec-a (bez blokiranja) ✅
**Opis:** Izmeriti resurse, proveriti logove (SSH, reverse proxy sajtova). Ako je bezbedno, instalirati samo detekciju i prikazati odluke u Nuvytrixu. Blokiranje traži posebno odobrenje.
**Prihvatanje:** izveštaj o resursima; ako je instaliran: sajtovi rade, nema automatskih blokada.
**Zavisi od:** NVX-13, NVX-21

### NVX-23 – Završno testiranje i dokumentacija ✅
_2026-11-17: svih 10 integracija proverenih na serveru (backup upozorava za homewise i portfolio, stvaran nalaz), 6 sajtova i Nuvytrix prate se kao HTTP ciljevi, audit dopunjen završnim stanjem._
**Opis:** Provera rutera, otkrivanja uređaja, obaveštenja, monitoringa, AdGuard-a, Docker-a, SSH-a, PostgreSQL-a, backup-a, Tailscale-a, svih 6 sajtova i Nuvytrixa. Ažurirati audit i `feature-parity.md`.
**Prihvatanje:** sve provereno na serveru; konačan izveštaj (gotovo / delimično / HARDWARE_LIMITED).
**Zavisi od:** svih prethodnih

---

**HARDWARE_LIMITED, ne radimo:** VLAN-ovi, SNMP, statistika po portu, port mirroring, PoE na switch-u, protok po uređaju, pregled paketa (TL-SG1008D je neupravljiv).
