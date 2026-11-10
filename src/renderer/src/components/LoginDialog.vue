<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { login } from '../stores/auth'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'success'])

const form = ref({ phone: '', password: '' })
const loading = ref(false)
const error = ref('')

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const canSubmit = computed(() => Boolean(form.value.phone.trim() && form.value.password))

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    error.value = ''
    loading.value = false
    form.value.phone = ''
    form.value.password = ''
  }
)

async function submit() {
  if (!canSubmit.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    // 服务地址由主进程按「设置 → 上报地址」的 origin 解析，登录框不再收集
    await login({
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
    width="340px"
    align-center
    :show-close="false"
    :close-on-click-modal="!loading"
  >
    <div class="head">
      <div class="title">登录会员账号</div>
    </div>

    <div class="fields">
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
  padding: 2px 2px 14px;
}

.title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--tx);
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
  width: 46px;
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
