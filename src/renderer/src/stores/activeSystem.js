import { ref } from 'vue'

/**
 * 当前选中的出票系统。
 *
 * 为什么要单独抽一个 store：影城账号（/cinemas）和影城配置（/systems）右边是两套完全
 * 不同的东西，左边却是同一棵系统树。原来各自持有一个 ref，来回切一次页面就得重新点一次
 * 系统 —— 一天几十趟，纯属浪费。
 *
 * 两个页面共用这一个 ref，再顺手落一份到 localStorage：应用重启后也能停在原来那套系统上。
 * localStorage 在 file:// 下有可能被禁用（生产是 loadFile 起的），所以读写都包了 try：
 * 存不进去就退化成「只在本次运行内记住」，功能不减。
 */

const STORAGE_KEY = 'cinema-auth-agent:active-system'

function readStoredId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : 0
  } catch {
    return 0
  }
}

/** 全进程共用：组件换页不销毁模块，ref 自然留得住 */
export const activeSystemId = ref(readStoredId())

/** 用户点了左侧某个系统 */
export function selectSystem(id) {
  const next = Number(id) || 0
  if (next === activeSystemId.value) return
  activeSystemId.value = next
  persist(next)
}

/**
 * 校正：缓存的系统可能已经被解绑（换账号、后台改了授权）。
 * 只有确认它不在树里时才改选，避免把用户的选择冲掉。
 */
export function ensureSystem(list, fallbackId) {
  const items = Array.isArray(list) ? list : []
  if (!items.length) return
  if (items.some((item) => item.id === activeSystemId.value)) return
  const next = fallbackId || items[0]?.id || 0
  activeSystemId.value = next
  persist(next)
}

function persist(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, String(id))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 存不进去不影响本次运行 */
  }
}

export default { activeSystemId, selectSystem, ensureSystem }
