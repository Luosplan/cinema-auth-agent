<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { formatDateTime } from '@utils/common'
import {
  caInfo,
  installCa as installCaCert,
  refreshCa,
  uninstallCa as uninstallCaCert
} from '@renderer/stores/ca'
import { openSettings } from '@renderer/stores/ui'

/**
 * 根证书小弹窗。
 *
 * 状态栏右下角点「证书」就弹它 —— 装证书是最常做的一件事，不该先跳进设置再找栏目。
 * 设置弹窗里那一栏继续留着（那边还有导出证书），两条路都通，逻辑共用 stores/ca.js。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])

const installing = ref(false)
const removing = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const hint = computed(() =>
  caInfo.installed
    ? '证书已安装。'
    : '请先安装证书。'
)

// 每次打开都复核一次：用户可能在 certmgr 里手动删过，缓存里的状态不一定还对
watch(visible, (open) => {
  if (open) refreshCa()
})

async function doInstall() {
  if (installing.value) return
  installing.value = true
  try {
    const res = await installCaCert()
    if (res?.ok) ElMessage.success('根证书已安装')
    else ElMessage.error(res?.message || '安装失败')
  } catch (e) {
    ElMessage.error(e.message || '安装失败')
  } finally {
    installing.value = false
  }
}

async function doRemove() {
  if (removing.value) return
  try {
    await ElMessageBox.confirm(
      // 卸载会连带停采集（主进程里做的），先说清楚，别让人以为采集还在跑
      '卸载后 HTTPS 内容解不开，采集也会一起停掉。确定卸载？',
      '卸载根证书',
      {
        confirmButtonText: '卸载',
        cancelButtonText: '取消',
        type: 'warning',
        appendTo: document.body
      }
    )
  } catch {
    return
  }

  removing.value = true
  try {
    const res = await uninstallCaCert()
    if (res?.ok) ElMessage.success(res.message || '已卸载根证书')
    else ElMessage.error(res?.message || '卸载失败')
  } catch (e) {
    ElMessage.error(e.message || '卸载失败')
  } finally {
    removing.value = false
  }
}

function goSettings() {
  visible.value = false
  openSettings('ca')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="ca-dlg"
    width="432px"
    align-center
    append-to-body
    :close-on-click-modal="false"
  >
    <template #header>
      <span class="dlg-title">根证书</span>
    </template>

    <div class="ca-body">
      <!-- 状态一眼可见：图标 + 一句话，不让人去读指纹判断装没装 -->
      <div class="hero" :class="caInfo.installed ? 'ok' : 'warn'">
        <svg class="hero-ico" viewBox="0 0 24 24">
          <path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z" />
          <path v-if="caInfo.installed" d="m9 12 2.2 2.2L15.4 10" />
          <path v-else d="M12 8.6v4M12 15.4v.1" />
        </svg>
        <div class="hero-main">
          <div class="hero-title">{{ caInfo.installed ? '已安装' : '未安装' }}</div>
          <div class="hero-desc">{{ hint }}</div>
        </div>
      </div>

      <dl class="meta">
        <div class="meta-row">
          <dt>证书指纹</dt>
          <dd class="mono ellipsis" :title="caInfo.fingerprint">{{ caInfo.fingerprint || '—' }}</dd>
        </div>
        <div v-if="caInfo.installed && caInfo.notAfter" class="meta-row">
          <dt>有效期至</dt>
          <dd class="mono">{{ formatDateTime(caInfo.notAfter) }}</dd>
        </div>
        <div class="meta-row">
          <dt>安装位置</dt>
          <dd>当前用户 → 受信任的根证书颁发机构</dd>
        </div>
      </dl>
    </div>

    <template #footer>
      <div class="ca-foot">
        <button class="link" type="button" @click="goSettings">更多设置</button>
        <div class="foot-right">
          <el-button v-if="!caInfo.installed" size="small" type="primary" :loading="installing" @click="doInstall">
            安装证书
          </el-button>
          <el-button v-else size="small" :loading="removing" @click="doRemove">卸载证书</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.ca-dlg {
  padding: 0;
  overflow: hidden;
}

.ca-dlg .el-dialog__header {
  margin: 0;
  padding: 13px 16px 12px;
  border-bottom: 1px solid var(--line-soft);
}

.ca-dlg .el-dialog__headerbtn {
  top: 8px;
  right: 8px;
}

.ca-dlg .el-dialog__body {
  padding: 0;
}

.ca-dlg .el-dialog__footer {
  padding: 10px 16px 12px;
  border-top: 1px solid var(--line-soft);
}

.dlg-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--tx);
}

.ca-body {
  padding: 14px 16px 4px;
}

/* ---- 状态块 ---- */
.hero {
  display: flex;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
}

.hero.ok {
  border-color: #cfe6d8;
  background: var(--ok-bg);
}

.hero.warn {
  border-color: #efdcc0;
  background: var(--warn-bg);
}

.hero-ico {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  margin-top: 1px;
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.hero.ok .hero-ico {
  stroke: var(--ok);
}

.hero.warn .hero-ico {
  stroke: var(--warn);
}

.hero-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--tx);
}

.hero-desc {
  margin-top: 3px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--tx-3);
}

/* ---- 明细 ---- */
.meta {
  margin: 12px 0 0;
  padding: 0;
}

.meta-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 0;
  font-size: 11.5px;
}

.meta-row + .meta-row {
  border-top: 1px solid var(--line-soft);
}

.meta-row dt {
  width: 60px;
  flex-shrink: 0;
  color: var(--tx-4);
}

.meta-row dd {
  margin: 0;
  min-width: 0;
  color: var(--tx-2);
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 底部 ---- */
.ca-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.link {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--tx-3);
  cursor: pointer;
}

.link:hover {
  color: var(--tx);
}

.foot-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
