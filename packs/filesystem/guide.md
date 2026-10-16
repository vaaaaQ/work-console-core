## For the person

List the folders runs may reach in the pack's `roots` setting, one path each. The server reaches nothing outside
them. Turning the pack on lets runs read there; tick `write_file`, `edit_file`, `create_directory` or `move_file`
only when a job has to change files in those folders.

## For a run

- `list_allowed_directories` first: these are the only folders the server reaches.
- Read with `read_text_file`, `read_multiple_files`, `list_directory`, `directory_tree` and `search_files`.
- Your own work dir is yours already: use the filesystem tools only for the listed folders.
- A tool you were not given is refused and shows on the step; ask for it with `request_access` instead of retrying.
