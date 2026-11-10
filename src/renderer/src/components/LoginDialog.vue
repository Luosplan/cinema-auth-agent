<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { auth, login } from '../stores/auth'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'success'])

const form = ref({ baseUrl: '', phone: '', password: '' })
const loading = ref(false)
const error = ref('')

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const canSubmit = computed(
  () => Boolean(form.value.baseUrl.trim() && form.value.phone.trim() && form.value.password)
)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    error.value = ''
    loading.value = false
    form.value.baseUrl = auth.baseUrl || ''
    form.value.phone = ''
    form.value.password = ''
  }
)

async function submit() {
  if (!canSubmit.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    await login({
      baseUrl: form.value.baseUrl.trim(),
      phone: form.value.phone.trim(),
      password: form.value.password
    })
    ElMessage.success('已登录')
    visible.value = false
    emit('success')
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    class="login-dialog"
    width="372px"
    align-center
    :show-close="false"
    :close-on-click-modal="!loading"
  >
    <div class="head">
      <div class="title">登录会员账号</div>
      <p class="desc">采集到的凭证归属该会员账号，一台设备同一时间只登录一个账号。</p>
    </div>

    <div class="fields">
      <label class="field">
        <span class="k">服务地址</span>
        <el-input
          v-model="form.baseUrl"
          size="small"
          placeholder="https://your-server.com/api"
          spellcheck="false"
        />
      </label>

      <label class="field">
        <span class="k">手机号</span>
        <el-input
          v-model="form.phone"
          size="small"
          placeholder="会员手机号"
          maxlength="11"
          @keyup.enter="submit"
        />
      </label>

      <label class="field">
        <span class="k">密码</span>
        <el-input
          v-model="form.password"
          size="small"
          type="password"
          placeholder="登录密码"
          @keyup.enter="submit"
        />
      </label>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else class="hint mono">设备标识 {{ auth.deviceId ? auth.deviceId.slice(0, 8) : '—' }}</p>

    <div class="actions">
      <el-button size="small" :disabled="loading" @click="visible = false">取消</el-button>
      <el-button
        size="small"
        type="primary"
        :loading="loading"
        :disabled="!canSubmit"
        @click="submit"
      >
        登录
      </el-button>
    </div>
  </el-dialog>
</template>

<style lang="scss" scoped>
.head {
  padding: 2px 2px 16px;
}

.title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
}

.desc {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--tx-3);
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field {
  display: flex;
  align-items: center;
  gap: 12px;
}

.k {
  width: 56px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--tx-2);
}

.field :deep(.el-input) {
  flex: 1;
}

.error {
  margin: 10px 0 0;
  padding: 7px 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--err);
  background: var(--err-bg);
  border-radius: var(--radius);
}

.hint {
  margin: 10px 0 0;
  font-size: 10.5px;
  color: var(--tx-4);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 18px;
}
</style>

<style lang="scss">
/* 弹窗自带 header 会破坏简洁感，整块重排 */
.login-dialog {
  padding: 18px 20px 16px;
}

.login-dialog .el-dialog__header {
  display: none;
}

.login-dialog .el-dialog__body {
  padding: 0;
}
</style>
