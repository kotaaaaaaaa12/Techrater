from pathlib import Path

model_path = Path("models/Data.cc")
source = model_path.read_text(encoding="utf-8")

columns_before = """const std::vector<std::string> &Data::insertColumns() noexcept
{
    static const std::vector<std::string> inCols={
        \"statistics\","""
columns_after = """const std::vector<std::string> &Data::insertColumns() noexcept
{
    static const std::vector<std::string> inCols={
        \"id\",
        \"statistics\","""

arguments_before = """void Data::outputArgs(drogon::orm::internal::SqlBinder &binder) const
{
    if(dirtyFlag_[1])"""
arguments_after = """void Data::outputArgs(drogon::orm::internal::SqlBinder &binder) const
{
    if(dirtyFlag_[0])
    {
        binder << getValueOfId();
    }
    if(dirtyFlag_[1])"""

if columns_before not in source or arguments_before not in source:
    raise SystemExit("The expected generated Data model blocks were not found")

source = source.replace(columns_before, columns_after, 1)
source = source.replace(arguments_before, arguments_after, 1)
model_path.write_text(source, encoding="utf-8")
