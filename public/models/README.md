# 模型资产说明

## xq-yolo-640.onnx

象棋棋子 + 棋盘检测模型（YOLOv5n，输入 640×640，输出 [1,25200,20]：4 框参数 + objectness + 15 类）。

- **来源**：[Vincentzyx/VinXiangQi](https://github.com/Vincentzyx/VinXiangQi) v1.4.0 release 包 `Models/小模型.onnx`（zip 内原名，见脚本提取记录）
- **SHA256**：`c51a772997ad1c44b360281363cd4138d86a3f5afcc424b00866397ee9a064d7`
- **大小**：7,550,248 字节
- **与 Android 版同源**：D:\chess-dike 的 `yolov5n_xq_fp16.tflite`（3,824,480 B）即由该模型 fp16 转换（onnx2tf → TFLiteConverter），Web 侧直接使用原始 ONNX，免二次转换
- **许可**：**GPL-3.0**（随 VinXiangQi 项目发布）。本仓库以学习/个人使用为目的引用；若再分发本应用，需一并遵守 GPL-3.0（提供许可文本与对应源码来源）。模型与代码资产分离存放，便于后续替换/移除。

## 备选模型（未采用）

VinXiangQi v1.4.0 同包内 `Models/中模型.onnx`（28,634,823 B，27.3 MiB）精度更高，但**超出 Cloudflare 静态资源单文件 25 MiB 硬上限**，无法随站点部署，未采用。
