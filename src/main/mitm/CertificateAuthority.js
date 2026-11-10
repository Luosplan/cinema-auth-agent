import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import forge from 'node-forge'

const CA_VALID_YEARS = 10
const LEAF_VALID_YEARS = 3
const LEAF_COMMON_NAME = 'CinemaAuthAgent Local Root CA'

/**
 * 本地根证书颁发机构。
 *
 * 职责：
 *   1. 首次运行时生成一对 RSA 根密钥并自签根证书，落盘到 userData
 *   2. 按需为被劫持的域名签发叶子证书（用于 TLS 中间人解密）
 *
 * 性能注意：
 *   RSA 2048 密钥对生成需要 0.5~2 秒，如果每个域名都新生成密钥对，
 *   客户机上会出现明显的首包卡顿。因此所有叶子证书复用同一对密钥，
 *   仅重新签发 CN / SAN —— 这是 whistle、anyproxy 等工具的通行做法。
 */
export default class CertificateAuthority {
  constructor(storageDir) {
    this.storageDir = storageDir
    this.caCertPath = path.join(storageDir, 'ca-cert.pem')
    this.caKeyPath = path.join(storageDir, 'ca-key.pem')
    this.caCert = null
    this.caKey = null
    this.leafKeys = null
    this.issuedCache = new Map()
  }

  /**
   * 加载或生成根证书。同步执行，必须在启动代理前调用完毕。
   */
  init() {
    fs.mkdirSync(this.storageDir, { recursive: true })

    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      try {
        this.caCert = forge.pki.certificateFromPem(fs.readFileSync(this.caCertPath, 'utf8'))
        this.caKey = forge.pki.privateKeyFromPem(fs.readFileSync(this.caKeyPath, 'utf8'))
        const notAfter = this.caCert.validity.notAfter.getTime()
        // 根证书快到期（30 天内）时重新生成，避免客户机上突然全部失效
        if (notAfter - Date.now() > 30 * 24 * 3600 * 1000) {
          return { created: false, notAfter: this.caCert.validity.notAfter }
        }
      } catch {
        // 文件损坏则走重新生成流程
      }
    }

    this.generate()
    return { created: true, notAfter: this.caCert.validity.notAfter }
  }

  generate() {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()

    cert.publicKey = keys.publicKey
    cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex')

    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + CA_VALID_YEARS
    )

    const attrs = [
      { name: 'commonName', value: LEAF_COMMON_NAME },
      { name: 'organizationName', value: 'CinemaAuthAgent' },
      { name: 'organizationalUnitName', value: 'Local Traffic Inspection' },
      { name: 'countryName', value: 'CN' }
    ]

    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        cRLSign: true,
        critical: true
      },
      { name: 'subjectKeyIdentifier' }
    ])

    cert.sign(keys.privateKey, forge.md.sha256.create())

    fs.writeFileSync(this.caCertPath, forge.pki.certificateToPem(cert), 'utf8')
    fs.writeFileSync(this.caKeyPath, forge.pki.privateKeyToPem(keys.privateKey), 'utf8')

    this.caCert = cert
    this.caKey = keys.privateKey
    this.issuedCache.clear()
  }

  /**
   * 根证书 PEM，用于导出给用户安装。
   */
  getCaPem() {
    if (!this.caCert) throw new Error('CA 尚未初始化')
    return forge.pki.certificateToPem(this.caCert)
  }

  /**
   * 根证书指纹，用来判断客户机上装的是不是当前这一份。
   */
  getFingerprint() {
    if (!this.caCert) throw new Error('CA 尚未初始化')
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes()
    const digest = crypto.createHash('sha1').update(Buffer.from(der, 'binary')).digest('hex')
    return digest.toUpperCase().match(/.{2}/g).join(':')
  }

  getLeafKeys() {
    if (!this.leafKeys) {
      // 叶子密钥只生成一次，之后复用于所有域名
      const keys = forge.pki.rsa.generateKeyPair(2048)
      this.leafKeys = {
        privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
        publicKey: keys.publicKey
      }
    }
    return this.leafKeys
  }

  /**
   * 为指定域名签发叶子证书。
   * @param {string} hostname
   * @returns {{ key: string, cert: string }}
   */
  issue(hostname) {
    const cached = this.issuedCache.get(hostname)
    if (cached) return cached

    const leafKeys = this.getLeafKeys()
    const cert = forge.pki.createCertificate()

    cert.publicKey = leafKeys.publicKey
    cert.serialNumber = '02' + crypto.randomBytes(8).toString('hex')

    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + LEAF_VALID_YEARS
    )

    cert.setSubject([{ name: 'commonName', value: hostname }])
    cert.setIssuer(this.caCert.subject.attributes)
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [this.toAltName(hostname)]
      }
    ])

    cert.sign(this.caKey, forge.md.sha256.create())

    const result = {
      key: leafKeys.privateKeyPem,
      cert: forge.pki.certificateToPem(cert)
    }
    this.issuedCache.set(hostname, result)
    return result
  }

  /**
   * IP 形式的 host 必须用 type 7（iPAddress），否则 Chrome / 微信会判定证书不匹配。
   */
  toAltName(hostname) {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
    return isIp ? { type: 7, ip: hostname } : { type: 2, value: hostname }
  }
}
