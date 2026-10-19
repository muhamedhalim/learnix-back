# learnix.school DNS evidence captured 2026-10-18 (public resolver cache of the Cloudflare era vs Vercel authoritative)
```

##### server 1.1.1.1
A     learnix.school => ["172.67.165.1","104.21.41.129"]
AAAA  learnix.school => ["2606:4700:3036::6815:2981","2606:4700:3031::ac43:a501"]
MX    learnix.school => [{"exchange":"route3.mx.cloudflare.net","priority":5,"type":"MX"},{"exchange":"route2.mx.cloudflare.net","priority":59,"type":"MX"},{"exchange":"route1.mx.cloudflare.net","priority":63,"type":"MX"}]
TXT   learnix.school => [["brevo-code:4a888ed29490d7c2c242ee95107c5548"],["v=spf1 include:_spf.mx.cloudflare.net include:_spf.mailersend.net ~all"]]
CAA   learnix.school => [{"critical":0,"type":"CAA","issue":"comodoca.com"},{"critical":0,"type":"CAA","issue":"digicert.com; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issue":"letsencrypt.org"},{"critical":0,"type":"CAA","issue":"pki.goog; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issue":"sectigo.com"},{"critical":0,"type":"CAA","issue":"ssl.com"},{"critical":0,"type":"CAA","issuewild":"comodoca.com"},{"critical":0,"type":"CAA","issuewild":"digicert.com; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issuewild":"letsencrypt.org"},{"critical":0,"type":"CAA","issuewild":"pki.goog; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issuewild":"ssl.com"}]
NS    learnix.school => ["dina.ns.cloudflare.com","max.ns.cloudflare.com"]
A     www.learnix.school => ["172.67.165.1","104.21.41.129"]
A     api.learnix.school => ["172.67.165.1","104.21.41.129"]
A     staging.learnix.school => ["172.67.165.1","104.21.41.129"]
A     api-staging.learnix.school => ["104.21.41.129","172.67.165.1"]
TXT   _dmarc.learnix.school => [["v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com"]]
CNAME mlsend2._domainkey.learnix.school => ["mlsend2._domainkey.mailersend.net"]
CNAME brevo1._domainkey.learnix.school => ["b1.learnix-school.dkim.brevo.com"]
CNAME brevo2._domainkey.learnix.school => ["b2.learnix-school.dkim.brevo.com"]
TXT   cf2024-1._domainkey.learnix.school => [["v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78k","m4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB"]]

##### server 8.8.8.8
A     learnix.school => ["172.67.165.1","104.21.41.129"]
AAAA  learnix.school => ["2606:4700:3036::6815:2981","2606:4700:3031::ac43:a501"]
MX    learnix.school => [{"exchange":"route1.mx.cloudflare.net","priority":63,"type":"MX"},{"exchange":"route3.mx.cloudflare.net","priority":5,"type":"MX"},{"exchange":"route2.mx.cloudflare.net","priority":59,"type":"MX"}]
TXT   learnix.school => [["v=spf1 include:_spf.mx.cloudflare.net include:_spf.mailersend.net ~all"],["brevo-code:4a888ed29490d7c2c242ee95107c5548"]]
CAA   learnix.school => [{"critical":0,"type":"CAA","issuewild":"letsencrypt.org"},{"critical":0,"type":"CAA","issue":"sectigo.com"},{"critical":0,"type":"CAA","issuewild":"comodoca.com"},{"critical":0,"type":"CAA","issue":"comodoca.com"},{"critical":0,"type":"CAA","issue":"pki.goog; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issue":"digicert.com; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issuewild":"pki.goog; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issue":"ssl.com"},{"critical":0,"type":"CAA","issuewild":"ssl.com"},{"critical":0,"type":"CAA","issuewild":"digicert.com; cansignhttpexchanges=yes"},{"critical":0,"type":"CAA","issue":"letsencrypt.org"}]
NS    learnix.school => ["max.ns.cloudflare.com","dina.ns.cloudflare.com"]
A     www.learnix.school => ["172.67.165.1","104.21.41.129"]
A     api.learnix.school => ["172.67.165.1","104.21.41.129"]
A     staging.learnix.school => ["172.67.165.1","104.21.41.129"]
A     api-staging.learnix.school => ["104.21.41.129","172.67.165.1"]
TXT   _dmarc.learnix.school => [["v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com"]]
CNAME mlsend2._domainkey.learnix.school => ["mlsend2._domainkey.mailersend.net"]
CNAME brevo1._domainkey.learnix.school => ["b1.learnix-school.dkim.brevo.com"]
CNAME brevo2._domainkey.learnix.school => ["b2.learnix-school.dkim.brevo.com"]
TXT   cf2024-1._domainkey.learnix.school => [["v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78k","m4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB"]]

##### server 198.51.44.13
A     learnix.school => ["64.29.17.65","216.198.79.1"]
CAA   learnix.school => [{"critical":0,"type":"CAA","issue":"letsencrypt.org"},{"critical":0,"type":"CAA","issue":"pki.goog"},{"critical":0,"type":"CAA","issue":"sectigo.com"}]
NS    learnix.school => ["ns1.vercel-dns.com","ns2.vercel-dns.com"]
A     www.learnix.school => ["64.29.17.65","216.198.79.65"]
A     api.learnix.school => ["216.198.79.1","64.29.17.65"]
A     staging.learnix.school => ["64.29.17.65","216.198.79.65"]
A     api-staging.learnix.school => ["216.198.79.1","216.198.79.65"]
CNAME _domainconnect.learnix.school => ["_domainconnect.vercel-dns.com"]

["issue comodoca.com","issue digicert.com; cansignhttpexchanges=yes","issue letsencrypt.org","issue pki.goog; cansignhttpexchanges=yes","issue sectigo.com","issue ssl.com","issuewild comodoca.com","issuewild digicert.com; cansignhttpexchanges=yes","issuewild letsencrypt.org","issuewild pki.goog; cansignhttpexchanges=yes","issuewild ssl.com"]
v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78km4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB
len 420
```
