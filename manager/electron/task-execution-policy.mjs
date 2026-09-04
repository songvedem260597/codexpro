export const TASK_SIZE_VALUES = Object.freeze(["small", "medium", "large"]);

export function normalizeTaskSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TASK_SIZE_VALUES.includes(normalized) ? normalized : "";
}

export function buildAutonomousTaskExecutionPolicy(taskId) {
  const id = String(taskId || "").trim();
  if (!/^cpt_[a-f0-9]{24}$/.test(id)) throw new Error("Autonomous task policy requires a valid Task ID.");
  return [
    "QUY TRÌNH TỰ CHỦ BẮT BUỘC:",
    "1. Tự xác định đây là task mới hay điều chỉnh task đang chạy; phân loại general/code, đánh giá task_size=small|medium|large, chọn đúng repo/workspace và giữ thứ tự FIFO.",
    "2. Với task code, tự điều tra trước khi sửa: đọc source/test gần nhất, log và Git history liên quan; truy call/data flow, tái hiện lỗi khi khả thi, xác định nguyên nhân gốc và phạm vi ảnh hưởng.",
    "3. Không hỏi người dùng chỉ vì task phức tạp, mơ hồ hoặc thiếu chi tiết kỹ thuật. Tự chọn giả định an toàn và phạm vi nhỏ nhất phù hợp. Chỉ hỏi khi cần quyết định sản phẩm làm đổi đáng kể hành vi, thao tác khó hoàn tác/xóa dữ liệu, thiếu quyền/credential, yêu cầu mâu thuẫn không thể suy luận, hoặc phải mở rộng ngoài phạm vi được giao.",
    "4. Task nhỏ và rõ có thể triển khai sau điều tra ngắn. Task vừa phải có checklist ngắn. Task lớn/phức tạp BẮT BUỘC tạo checklist chi tiết trước khi sửa source.",
    `5. Checklist phải được lưu qua report_worker_job_progress cho Task ID ${id}; mỗi item có id, title, status=pending|in_progress|completed|blocked và evidence tùy chọn. Chỉ một item được in_progress. Mỗi checkpoint phải gửi toàn bộ checklist hiện tại để phục hồi sau reload/mất kết nối/rollover.`,
    "6. Triển khai tuần tự, sửa nguyên nhân gốc, không refactor ngoài phạm vi, thêm regression test khi kiểm thử được; cập nhật checklist và completed_parts/remaining_parts sau mỗi phần có ý nghĩa.",
    "7. Tin nhắn gửi tiếp trong lượt chạy hiện tại là điều chỉnh cùng task: giữ Task ID/title/kind/workspace, cập nhật checklist và không tạo task FIFO mới. Chỉ tạo task mới sau tín hiệu hoàn thành hoặc khi người dùng nói rõ.",
    "8. Sau thay đổi cuối, chạy test hẹp, regression smoke, build và smoke rộng khi ảnh hưởng nhiều subsystem. Nếu lỗi, quay lại điều tra/triển khai trong cùng task.",
    "9. Nếu yêu cầu giao source hoàn chỉnh, review diff, commit, cập nhật trên nhánh đích, xử lý conflict, test lại, push/integrate và xác minh remote. Nếu yêu cầu bản chạy, build/cài an toàn, không tự đóng app đang dùng nếu không cần và xác minh runtime sau khi mở lại.",
    "10. Chỉ completed khi mọi checklist bắt buộc, verify và delivery đã xong. Khi lỗi/treo, lưu checkpoint rồi phục hồi trong cùng Task ID; nếu không thể tiếp tục, báo blocked/error/stalled với bằng chứng và phần còn lại."
  ];
}
