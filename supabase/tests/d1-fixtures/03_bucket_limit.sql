-- expect: file_size_limit
-- TC-B0-74：手工把 images 的大小限制改大
update storage.buckets set file_size_limit = 99999999 where id = 'images';
