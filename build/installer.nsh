# 自定义安装脚本 —— electron-builder 会自动引入 build/installer.nsh，不需要在 yml 里配置
#
# 覆盖安装时，新安装包会先跑旧版本的卸载器（Uninstall xxx.exe /S _?=旧目录），
# 然后检查它的退出码。非 0 就弹
#   「Failed to uninstall old application files. Please try running the installer again.: 2」
# 并直接退出 —— 客户就卡在这一步，装不下去。
#
# 现场常见原因：上一版的程序名不同（CinemaAuthAgent → HK票务助手，卸载器文件名对不上）、
# 安装目录被手动删过、旧卸载器被安全软件拦下、或旧版还残留在另一个安装位置。
# 这些情况下最好的结果不是拦住安装，而是继续覆盖安装：新版本装到自己的目录，
# 旧目录残留不影响使用。所以这里接管两个检查宏，只记一行日志，不再弹窗退出。
#
# 注意：必须两个都定义 —— 安装程序会分别对 SHELL_CONTEXT 和 HKEY_CURRENT_USER 各查一次，
# 只定义其中一个，另一个分支仍会弹窗退出。
!macro customUnInstallCheck
  DetailPrint "旧版卸载未完成（退出码 $R0），继续安装新版本"
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "旧版卸载未完成（退出码 $R0），继续安装新版本"
!macroend
